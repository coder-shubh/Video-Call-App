const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const sanitizeHtml = require("sanitize-html"); // For sanitizing chat messages

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// Store active users in rooms
// Structure: { roomId: { socketId: { userId: string, status: { audio: boolean, video: boolean } } } }
const activeRooms = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomId, userId) => {
    // Validate roomId and userId
    if (!roomId || !userId || typeof roomId !== "string" || typeof userId !== "string") {
      socket.emit("error", "Invalid room ID or user ID");
      return;
    }

    socket.join(roomId);
    if (!activeRooms[roomId]) {
      activeRooms[roomId] = {};
    }
    activeRooms[roomId][socket.id] = { userId: sanitizeHtml(userId), status: { audio: true, video: true } };

    // Notify existing users in the room about the new user
    socket.to(roomId).emit("user-connected", socket.id, userId);

    // Send existing users' info to the new user
    const existingUsers = Object.keys(activeRooms[roomId])
      .filter((id) => id !== socket.id)
      .map((id) => ({
        id: id,
        name: activeRooms[roomId][id].userId,
        status: activeRooms[roomId][id].status,
      }));
    socket.emit("existing-users", existingUsers);

    console.log(`User ${userId} (${socket.id}) joined room ${roomId}`);
    console.log("Current room members:", activeRooms[roomId]);

    // Handle user status updates (e.g., mic or camera toggled)
    socket.on("update-status", (status) => {
      if (activeRooms[roomId][socket.id]) {
        activeRooms[roomId][socket.id].status = status;
        socket.to(roomId).emit("user-status-updated", socket.id, status);
      }
    });

    // Handle chat messages
    socket.on("chat-message", (messageData) => {
      const { message } = messageData;
      let currentRoomId = null;
      for (const room of socket.rooms) {
        if (room !== socket.id) {
          currentRoomId = room;
          break;
        }
      }

      if (currentRoomId && activeRooms[currentRoomId]) {
        const senderName = activeRooms[currentRoomId][socket.id]?.userId || "Unknown User";
        const sanitizedMessage = sanitizeHtml(message, {
          allowedTags: [],
          allowedAttributes: {},
        });
        io.to(currentRoomId).emit("chat-message", {
          message: sanitizedMessage,
          userId: senderName,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.warn(`Chat message from ${socket.id} not associated with a room.`);
      }
    });

    // Handle WebRTC signals
    socket.on("signal", (data) => {
      const { targetId, signal } = data;
      if (activeRooms[roomId] && activeRooms[roomId][targetId]) {
        io.to(targetId).emit("signal", {
          senderId: socket.id,
          signal: signal,
          senderName: activeRooms[roomId][socket.id].userId, // Include sender's name
        });
      } else {
        console.warn(`Signal for unknown targetId ${targetId} in room ${roomId}`);
      }
    });

    socket.on("disconnect", () => {
      for (const room in activeRooms) {
        if (activeRooms[room][socket.id]) {
          const disconnectedUserName = activeRooms[room][socket.id].userId;
          delete activeRooms[room][socket.id];
          socket.to(room).emit("user-disconnected", disconnectedUserName);
          console.log(`User ${disconnectedUserName} removed from room ${room}`);

          if (Object.keys(activeRooms[room]).length === 0) {
            delete activeRooms[room];
            console.log(`Room ${room} is empty and deleted.`);
          }
          break;
        }
      }
    });

    socket.on("disconnect-call", () => {
      socket.disconnect(true);
    });

    socket.on("end-call", (roomId) => {
      io.in(roomId).emit("call-ended");
      if (activeRooms[roomId]) {
        delete activeRooms[roomId];
        console.log(`Room ${roomId} ended.`);
      }
    });
  });
});

http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});