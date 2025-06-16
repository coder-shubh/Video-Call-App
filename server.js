const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// Store user language preferences
const userLanguagePreferences = new Map(); // Map: socket.id -> { spoken: 'langCode', target: 'langCode' }

// Store placeholder "streaming clients" for STT/TTS per user
// In a real application, these would be instances of actual API clients
const streamingSttClients = new Map(); // Map: socket.id -> STT_API_Client_Instance
const streamingTtsClients = new Map(); // Map: socket.id -> TTS_API_Client_Instance

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Handle joining a room
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit("user-connected", socket.id);
    console.log(`User ${socket.id} joined room ${roomId}`);

    // Store the room ID for this socket
    socket.data.roomId = roomId;

    // Send existing user language preferences to the newly connected user
    // This helps the new user know the languages of others already in the call
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size > 1) {
      for (const peerSocketId of room) {
        if (peerSocketId !== socket.id && userLanguagePreferences.has(peerSocketId)) {
          socket.emit("peer-language-update", {
            userId: peerSocketId,
            languages: userLanguagePreferences.get(peerSocketId),
          });
        }
      }
    }
  });

  // Handle setting user language preferences
  socket.on("set-languages", (languages) => {
    userLanguagePreferences.set(socket.id, languages);
    console.log(`User ${socket.id} set languages:`, languages);

    // Broadcast language update to other users in the same room
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit("peer-language-update", {
        userId: socket.id,
        languages: languages,
      });
    }
  });

  // Handle incoming audio chunks for translation
  socket.on("audio-chunk-for-translation", async (data) => {
    const { chunk, spokenLanguage, targetLanguage } = data;
    const senderId = socket.id;
    const roomId = socket.data.roomId;

    if (!roomId) {
      console.warn(`Audio chunk received from ${senderId} but no room ID found.`);
      return;
    }

    try {
      // Step 1: Speech-to-Text (STT) - Convert sender's spoken audio to text
      // In a real app, you'd manage a streaming STT client instance per user.
      const transcribedText = await _callStreamingSTT(chunk, spokenLanguage, senderId);

      if (transcribedText) {
        console.log(`[STT from ${senderId} (${spokenLanguage})]: ${transcribedText}`);

        // Step 2: Text Translation - Translate the text to the target language
        const translatedText = await _callTranslationAPI(transcribedText, spokenLanguage, targetLanguage);

        if (translatedText) {
          console.log(`[Translated to ${targetLanguage} for ${senderId}]: ${translatedText}`);

          // Step 3: Text-to-Speech (TTS) - Convert translated text to audio
          // In a real app, you'd manage a streaming TTS client instance per recipient.
          const translatedAudioBuffer = await _callStreamingTTS(translatedText, targetLanguage, senderId); // Use senderId as context for TTS client if needed

          if (translatedAudioBuffer) {
            // Step 4: Send translated audio to the recipient(s)
            // For a 1-to-1 call, find the other user in the room
            const room = io.sockets.adapter.rooms.get(roomId);
            if (room) {
              for (const recipientSocketId of room) {
                if (recipientSocketId !== senderId) {
                  // Only send if the recipient's target language matches this translation
                  const recipientLangs = userLanguagePreferences.get(recipientSocketId);
                  if (recipientLangs && recipientLangs.spoken === targetLanguage) {
                    io.to(recipientSocketId).emit("translated-audio-chunk", translatedAudioBuffer);
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error processing audio chunk from ${senderId}:`, error);
      // Implement more robust error handling, e.g., send error to client
    }
  });


  // Handle incoming chat messages
  socket.on("chat-message", (messageData) => {
    const { message, roomId } = messageData;
    io.to(roomId).emit("chat-message", { message: message, userId: socket.id });
  });

  // Handle other events
  socket.on("signal", (data) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit("signal", { id: socket.id, signal: data });
    }
  });

  socket.on("disconnect-call", () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit("user-disconnected", socket.id);
      console.log(`User ${socket.id} intentionally disconnected from room ${roomId}`);
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit("user-disconnected", socket.id);
      console.log(`User ${socket.id} disconnected from room ${roomId}`);
    }
    // Clean up language preferences and streaming clients
    userLanguagePreferences.delete(socket.id);
    streamingSttClients.delete(socket.id); // Clean up STT client if managed per user
    streamingTtsClients.delete(socket.id); // Clean up TTS client if managed per user
  });

  socket.on("end-call", (roomId) => {
    io.in(roomId).emit("call-ended"); // send to everyone in the room
    console.log(`Call ended in room ${roomId}`);
  });
});

http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// --- PLACEHOLDER AI API FUNCTIONS ---
// IMPORTANT: Replace these with actual API calls to your chosen cloud services.
// You'll need to manage API keys, client instances, and error handling.

/**
 * Placeholder for Streaming Speech-to-Text API call.
 * In a real scenario, you'd manage a persistent streaming connection (e.g., WebSocket or gRPC stream).
 * This function would send audio chunks to that stream and collect transcribed text.
 * @param {Float32Array} audioChunk - Raw audio data.
 * @param {string} languageCode - BCP-47 language tag (e.g., 'en-US', 'hi-IN', 'ja-JP').
 * @param {string} userId - The ID of the user speaking.
 * @returns {Promise<string>} - The transcribed text.
 */
async function _callStreamingSTT(audioChunk, languageCode, userId) {
  // --- REPLACE WITH ACTUAL STT API INTEGRATION ---
  // Example with a very basic dummy response:
  console.log(`[MOCK STT] Processing audio for user ${userId} in ${languageCode}...`);
  await new Promise(resolve => setTimeout(resolve, 150)); // Simulate network/processing delay

  const mockResponses = {
    'en-US': "This is a mock English transcription.",
    'hi-IN': "यह एक नकली हिंदी प्रतिलेखन है।", // Yeh ek nakli Hindi pratilikhan hai.
    'ja-JP': "これは模擬日本語の文字起こしです。", // Kore wa mogi nihongo no mojiokoshi desu.
    'fr-FR': "Ceci est une transcription française simulée."
  };
  return mockResponses[languageCode] || "Mock transcription.";
}

/**
 * Placeholder for Text Translation API call.
 * @param {string} text - The text to translate.
 * @param {string} sourceLang - Source language BCP-47 tag.
 * @param {string} targetLang - Target language BCP-47 tag.
 * @returns {Promise<string>} - The translated text.
 */
async function _callTranslationAPI(text, sourceLang, targetLang) {
  // --- REPLACE WITH ACTUAL TRANSLATION API INTEGRATION ---
  // Example with a very basic dummy response:
  console.log(`[MOCK TRANSLATION] Translating "${text}" from ${sourceLang} to ${targetLang}...`);
  await new Promise(resolve => setTimeout(resolve, 100)); // Simulate network/processing delay

  // Very simplistic mock translation logic
  if (sourceLang === 'hi-IN' && targetLang === 'ja-JP') {
    return "こんにちは、お元気ですか？"; // Hello, how are you?
  } else if (sourceLang === 'ja-JP' && targetLang === 'hi-IN') {
    return "नमस्ते, आप कैसे हैं?"; // Namaste, aap kaise hain?
  } else if (sourceLang === 'en-US' && targetLang === 'ja-JP') {
    return "こんにちは、お元気ですか？";
  } else if (sourceLang === 'en-US' && targetLang === 'hi-IN') {
    return "नमस्ते, आप कैसे हैं?";
  } else if (sourceLang === 'hi-IN' && targetLang === 'en-US') {
    return "Hello, how are you?";
  } else if (sourceLang === 'ja-JP' && targetLang === 'en-US') {
    return "Hello, how are you?";
  }
  return `[MOCK TRANSLATED] ${text} (from ${sourceLang} to ${targetLang})`;
}

/**
 * Placeholder for Streaming Text-to-Speech API call.
 * In a real scenario, you'd manage a persistent streaming connection.
 * This function would send text to that stream and receive audio chunks.
 * @param {string} text - The text to convert to speech.
 * @param {string} languageCode - BCP-47 language tag for the desired voice.
 * @param {string} userId - The ID of the user who will receive this audio.
 * @returns {Promise<Uint8Array>} - A raw audio buffer (e.g., PCM Float32Array or Uint8Array of bytes).
 */
async function _callStreamingTTS(text, languageCode, userId) {
  // --- REPLACE WITH ACTUAL TTS API INTEGRATION ---
  // Example with a very basic dummy audio buffer (a silent chunk)
  console.log(`[MOCK TTS] Synthesizing "${text}" for user ${userId} in ${languageCode}...`);
  await new Promise(resolve => setTimeout(resolve, 200)); // Simulate network/processing delay

  // Return a dummy Float32Array representing a short period of silence
  const sampleRate = 48000; // Common sample rate
  const durationMs = 500; // Simulate 500ms of audio
  const numSamples = (sampleRate * durationMs) / 1000;
  return new Float32Array(numSamples);
}