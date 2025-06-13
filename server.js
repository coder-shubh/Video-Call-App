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
    // Send new user's socket ID and their chosen user ID
    socket.to(roomId).emit("user-connected", socket.id, userId);

    // Send existing users' info to the new user
    const existingUsers = Object.keys(activeRooms[roomId])
      .filter((id) => id !== socket.id)
      .map((id) => ({
        id: id, // The socket ID of the existing user
        name: activeRooms[roomId][id].userId, // The chosen user ID of the existing user
        status: activeRooms[roomId][id].status,
      }));
    socket.emit("existing-users", existingUsers);

    console.log(`User ${userId} (${socket.id}) joined room ${roomId}`);
    console.log("Current room members:", activeRooms[roomId]);

    // Handle user status updates (e.g., mic or camera toggled)
    socket.on("update-status", (status) => {
      if (activeRooms[roomId] && activeRooms[roomId][socket.id]) {
        activeRooms[roomId][socket.id].status = status;
        // Broadcast status update to all others in the room
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
      // Only send signal if the targetId exists in the current room
      if (activeRooms[roomId] && activeRooms[roomId][targetId]) {
        io.to(targetId).emit("signal", {
          senderId: socket.id,
          signal: signal,
          senderName: activeRooms[roomId][socket.id].userId, // Include sender's chosen user ID
        });
      } else {
        console.warn(`Signal for unknown targetId ${targetId} in room ${roomId}. Sender: ${socket.id}`);
      }
    });

    socket.on("disconnect", () => {
      // Find the room the user was in and remove them
      for (const room in activeRooms) {
        if (activeRooms[room][socket.id]) {
          const disconnectedUserName = activeRooms[room][socket.id].userId;
          delete activeRooms[room][socket.id];
          // Notify others in the room that this user disconnected
          socket.to(room).emit("user-disconnected", disconnectedUserName, socket.id); // Pass socket.id for removal
          console.log(`User ${disconnectedUserName} (${socket.id}) removed from room ${room}`);

          // If the room becomes empty, delete it
          if (Object.keys(activeRooms[room]).length === 0) {
            delete activeRooms[room];
            console.log(`Room ${room} is empty and deleted.`);
          }
          break; // User can only be in one room at a time for this simple example
        }
      }
      console.log("User disconnected:", socket.id);
    });

    // This event is typically triggered by the client to explicitly leave a call
    socket.on("disconnect-call", () => {
      // Find and remove the user from their room before completely disconnecting the socket
      for (const room in activeRooms) {
        if (activeRooms[room][socket.id]) {
          const disconnectedUserName = activeRooms[room][socket.id].userId;
          delete activeRooms[room][socket.id];
          socket.to(room).emit("user-disconnected", disconnectedUserName, socket.id);
          console.log(`User ${disconnectedUserName} (${socket.id}) explicitly disconnected from call in room ${room}`);

          if (Object.keys(activeRooms[room]).length === 0) {
            delete activeRooms[room];
            console.log(`Room ${room} is empty and deleted after explicit disconnect.`);
          }
          break;
        }
      }
      socket.disconnect(true); // Disconnect the underlying socket.io connection
    });

    // This event is for a host to end the call for everyone in the room
    socket.on("end-call", (roomIdToEnd) => {
      if (activeRooms[roomIdToEnd]) {
        io.in(roomIdToEnd).emit("call-ended"); // Notify all in the room to end their calls
        // Clean up all users in this room and then delete the room
        for (const socketId in activeRooms[roomIdToEnd]) {
          // This will trigger individual 'disconnect' events on each client's socket
          // which will also clean up their peer connections
          io.sockets.sockets.get(socketId)?.disconnect(true);
        }
        delete activeRooms[roomIdToEnd];
        console.log(`Room ${roomIdToEnd} ended by a user.`);
      }
    });
  });
});

http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});