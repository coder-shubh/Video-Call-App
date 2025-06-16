const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
// const { SpeechClient } = require('@google-cloud/speech').v1p1beta1; // For Google Cloud STT
// const { TranslationServiceClient } = require('@google-cloud/translate').v2; // For Google Cloud Translation
// const { TextToSpeechClient } = require('@google-cloud/text-to-speech'); // For Google Cloud TTS

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// Store user session data for translation pipeline
const userTranslationSessions = new Map(); // Map socket.id to { preferredLanguage: 'en-US', sttStream: null, currentTranscriptionBuffer: '' }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Initialize session data for new user
  userTranslationSessions.set(socket.id, {
    preferredLanguage: 'en-US', // Default language, can be updated by client
    sttStream: null,
    currentTranscriptionBuffer: '',
    lastAudioChunkTimestamp: Date.now(), // To manage STT stream lifecycle
    roomJoined: null, // To store the room this user is in
  });

  // Handle setting preferred language
  socket.on("set-preferred-language", (langCode) => {
    const session = userTranslationSessions.get(socket.id);
    if (session) {
      session.preferredLanguage = langCode;
      console.log(`User ${socket.id} set preferred language to ${langCode}`);
    }
  });

  socket.on("audio-chunk", async (data) => {
    const { chunk } = data; // chunk is a Float32Array transferred from client
    const userId = socket.id;
    const userSession = userTranslationSessions.get(userId);

    if (!userSession || !userSession.roomJoined) {
      console.warn(`Audio chunk received from uninitialized user ${userId} or not in a room.`);
      return;
    }

    userSession.lastAudioChunkTimestamp = Date.now(); // Update activity for STT stream management

    try {
      // 1. Send chunk to Streaming STT (e.g., Google Cloud Speech-to-Text)
      // Convert Float32Array to Buffer of Int16 for common STT APIs (LINEAR16)
      const audioBuffer = convertFloat32ToInt16Buffer(chunk);

      // Initialize STT streaming for this user if not already
      if (!userSession.sttStream) {
        userSession.sttStream = initializeStreamingSTT(userId, userSession.preferredLanguage);
      }

      userSession.sttStream.write(audioBuffer);

    } catch (error) {
      console.error("Error processing audio chunk for STT:", error);
      // Handle errors, e.g., send an error message to the client
    }
  });

  // Handle joining a room
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    const session = userTranslationSessions.get(socket.id);
    if (session) {
      session.roomJoined = roomId;
    }
    socket.to(roomId).emit("user-connected", socket.id);
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  // Handle incoming chat messages
  socket.on("chat-message", (messageData) => {
    const { message, roomId } = messageData;
    io.to(roomId).emit("chat-message", { message: message, userId: socket.id });
  });

  // Handle WebRTC signaling
  socket.on("signal", (data) => {
    const session = userTranslationSessions.get(socket.id);
    if (session && session.roomJoined) {
        // Find the other user in the room to send the signal to
        const recipientSocketId = getOtherUserInRoom(session.roomJoined, socket.id);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit("signal", { id: socket.id, signal: data });
        }
    }
  });

  // Handle call disconnection
  socket.on("disconnect-call", (roomId) => {
    socket.to(roomId).emit("user-disconnected", socket.id);
    endTranslationSession(socket.id); // End STT stream
    console.log(`User ${socket.id} intentionally disconnected from call in room ${roomId}`);
  });

  // Handle general socket disconnection
  socket.on("disconnect", () => {
    const session = userTranslationSessions.get(socket.id);
    if (session && session.roomJoined) {
      socket.to(session.roomJoined).emit("user-disconnected", socket.id);
      console.log(`User ${socket.id} disconnected from room ${session.roomJoined}`);
    }
    endTranslationSession(socket.id); // End STT stream
    console.log("User disconnected:", socket.id);
  });

  socket.on("end-call", (roomId) => {
    io.in(roomId).emit("call-ended"); // send to everyone in the room
  });
});

// --- Translation Pipeline Core Logic ---

// This function handles the results coming back from the STT service
async function handleSTTResult(userId, transcribedText, detectedLanguage, isFinal) {
  const userSession = userTranslationSessions.get(userId);
  if (!userSession || !userSession.roomJoined) return;

  // Find the other user in the room (the listener)
  const room = io.sockets.adapter.rooms.get(userSession.roomJoined);
  let recipientSocketId = null;
  if (room && room.size === 2) { // Assuming 1-on-1 call for simplicity
    for (const sId of room) {
      if (sId !== userId) {
        recipientSocketId = sId;
        break;
      }
    }
  }

  // If there's a recipient, proceed with translation
  if (recipientSocketId) {
    const recipientSession = userTranslationSessions.get(recipientSocketId);
    if (recipientSession) {
      const targetLanguage = recipientSession.preferredLanguage;

      // Update subtitles for the speaker (original text) immediately
      io.to(userId).emit("subtitle-data", {
        originalText: transcribedText,
        translatedText: "", // No translation needed for self
        spokenLanguage: detectedLanguage,
        targetLanguage: targetLanguage, // Still useful to know recipient's lang
        isFinal: isFinal
      });

      if (isFinal && transcribedText.trim() !== '') {
        console.log(`User ${userId} final STT: [${detectedLanguage}] "${transcribedText}"`);

        try {
          // 2. Translate the text
          const translatedText = await callTranslationAPI(transcribedText, detectedLanguage, targetLanguage);
          console.log(`Translated for ${recipientSocketId}: [${targetLanguage}] "${translatedText}"`);

          // 3. Convert translated text to speech
          const translatedAudioBuffer = await callStreamingTTS(translatedText, targetLanguage);

          if (translatedAudioBuffer) {
            // 4. Send translated audio back to the *other* user
            io.to(recipientSocketId).emit("translated-audio-chunk", translatedAudioBuffer);
          }

          // Update subtitles for the listener (original + translated)
          io.to(recipientSocketId).emit("subtitle-data", {
            originalText: transcribedText,
            translatedText: translatedText,
            spokenLanguage: detectedLanguage,
            targetLanguage: targetLanguage,
            isFinal: isFinal
          });
        } catch (error) {
          console.error(`Error in translation pipeline for user ${userId} to ${recipientSocketId}:`, error);
          // Optionally send an error message to clients
        }
      }
    }
  }
}

// Helper to convert client's Float32Array to a Buffer of Int16 (LINEAR16)
function convertFloat32ToInt16Buffer(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    int16Array[i] = Math.max(-1, Math.min(1, float32Array[i])) * 0x7FFF;
  }
  return Buffer.from(int16Array.buffer);
}

// End STT stream gracefully
function endTranslationSession(userId) {
  const session = userTranslationSessions.get(userId);
  if (session && session.sttStream) {
    session.sttStream.end(); // Or close for actual API client
    session.sttStream = null;
    console.log(`STT stream for ${userId} ended.`);
  }
  userTranslationSessions.delete(userId);
}

// --- Dummy Functions for Illustration - REPLACE WITH ACTUAL API CALLS ---

/**
 * Initializes and manages a streaming Speech-to-Text session for a user.
 * @param {string} userId The socket ID of the user.
 * @param {string} preferredLanguage The user's preferred language for recognition hint.
 * @returns {object} A mock stream object with a `write` method.
 */
function initializeStreamingSTT(userId, preferredLanguage) {
  // *** REPLACE THIS WITH ACTUAL GOOGLE CLOUD SPEECH-TO-TEXT (StreamingRecognize) ***
  // const speech = new SpeechClient();
  // const request = {
  //   config: {
  //     encoding: 'LINEAR16', // Ensure this matches client's audio format
  //     sampleRateHertz: 16000, // Ensure this matches client's audio sample rate
  //     languageCode: preferredLanguage, // Use preferred language as a hint
  //     alternativeLanguageCodes: ['en-US', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'zh-CN', 'ko-KR', 'ru-RU', 'ar-EG'], // List of languages to detect
  //     enableAutomaticPunctuation: true,
  //     model: 'default', // Or 'video' for better video call performance
  //   },
  //   interimResults: true, // Get interim results for low latency subtitles
  // };

  // const recognizeStream = client.streamingRecognize(request)
  //   .on('error', (err) => {
  //     console.error(`STT Stream Error for ${userId}:`, err);
  //     endTranslationSession(userId); // Attempt to clean up on error
  //   })
  //   .on('data', (data) => {
  //     if (data.results && data.results[0]) {
  //       const result = data.results[0];
  //       const transcription = result.alternatives[0].transcript;
  //       const detectedLanguage = result.languageCode || preferredLanguage; // Fallback
  //       const isFinal = result.isFinal;
  //       handleSTTResult(userId, transcription, detectedLanguage, isFinal);
  //     }
  //   });
  // return recognizeStream;


  console.log(`[DUMMY STT] Initialized for ${userId}, hinting: ${preferredLanguage}`);
  // Simulate STT stream receiving audio chunks and periodically sending results
  let accumulatedSpeech = "";
  let timeoutId = null;

  const mockStream = {
    write: (audioChunk) => {
      // In a real scenario, audioChunk goes to the STT API
      // Simulate some processing time
      clearTimeout(timeoutId); // Reset silence timer

      // Simulate accumulating speech and then getting a "final" result after a pause
      accumulatedSpeech += `chunk(${audioChunk.length}) `;

      // Trigger an interim result frequently
      setTimeout(() => {
          handleSTTResult(userId, "Speaking...", "en-US", false);
      }, 50);

      // Set a timeout to simulate end of utterance (final result) if no more chunks
      timeoutId = setTimeout(() => {
          const simulatedText = `[Simulated] "${accumulatedSpeech.trim()}"`;
          const simulatedLang = preferredLanguage.split('-')[0] || 'en'; // Simulate detected language
          handleSTTResult(userId, simulatedText, simulatedLang, true);
          accumulatedSpeech = ""; // Reset for next utterance
      }, 500); // 500ms of silence
    },
    end: () => {
      clearTimeout(timeoutId);
      console.log(`[DUMMY STT] Stream ended for ${userId}.`);
    }
  };
  return mockStream;
}

/**
 * Calls a translation API.
 * @param {string} text The text to translate.
 * @param {string} sourceLang The source language code (e.g., 'en', 'es').
 * @param {string} targetLang The target language code (e.g., 'ja', 'fr').
 * @returns {Promise<string>} The translated text.
 */
async function callTranslationAPI(text, sourceLang, targetLang) {
  // *** REPLACE THIS WITH ACTUAL GOOGLE CLOUD TRANSLATION (translate.v2) ***
  // const translate = new TranslationServiceClient();
  // const [response] = await translate.translateText({
  //   parent: `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}`, // Your project ID
  //   contents: [text],
  //   sourceLanguageCode: sourceLang,
  //   targetLanguageCode: targetLang,
  // });
  // return response.translations[0].translatedText;

  console.log(`[DUMMY TRANSLATION] Translating from ${sourceLang} to ${targetLang}: "${text}"`);
  await new Promise(resolve => setTimeout(resolve, 50)); // Simulate network delay
  // Simple dummy translation logic
  const dummyTranslations = {
    "en": "Hello, how are you?",
    "es": "Hola, ¿cómo estás?",
    "fr": "Bonjour, comment allez-vous?",
    "ja": "こんにちは、お元気ですか？",
    "ko": "안녕하세요, 잘 지내세요?",
    "zh": "你好，你好吗？",
    "ru": "Здравствуйте, как дела?",
    "ar": "مرحبا كيف حالك؟"
  };
  const translated = dummyTranslations[targetLang.substring(0,2)] || `[Translated to ${targetLang}] ${text}`;
  return translated;
}

/**
 * Calls a streaming Text-to-Speech API to convert text to audio.
 * @param {string} text The text to synthesize.
 * @param {string} languageCode The language code for synthesis (e.g., 'en-US', 'ja-JP').
 * @returns {Promise<Uint8Array>} The audio buffer. (In a real streaming scenario, this might emit multiple chunks)
 */
async function callStreamingTTS(text, languageCode) {
  // *** REPLACE THIS WITH ACTUAL GOOGLE CLOUD TEXT-TO-SPEECH (synthesizeSpeech) ***
  // For streaming, you'd typically get byte streams and forward them.
  // This example simulates a single buffer for simplicity, but real TTS
  // for long texts might return multiple chunks.
  // const ttsClient = new TextToSpeechClient();
  // const [response] = await ttsClient.synthesizeSpeech({
  //   input: { text: text },
  //   voice: { languageCode: languageCode, ssmlGender: 'NEUTRAL' }, // Choose appropriate voice
  //   audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 16000 }, // Match client playback
  // });
  // return new Uint8Array(response.audioContent); // Convert buffer to Uint8Array

  console.log(`[DUMMY TTS] Synthesizing for ${languageCode}: "${text}"`);
  await new Promise(resolve => setTimeout(resolve, 70)); // Simulate network + processing delay
  // Return a dummy audio buffer (empty Uint8Array for now)
  return new Uint8Array([/* dummy audio bytes */]); // Replace with actual audio
}

// Utility to get the other user's socket ID in a 1-on-1 room
function getOtherUserInRoom(roomId, currentUserSocketId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (room && room.size === 2) {
    for (const socketId of room) {
      if (socketId !== currentUserSocketId) {
        return socketId;
      }
    }
  }
  return null;
}

http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});