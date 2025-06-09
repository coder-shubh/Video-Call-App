const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// Store active users in rooms
// Structure: { roomId: { socketId: { userId: string, peerConnections: {} }, ... } }
const activeRooms = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomId, userId) => {
    socket.join(roomId);
    if (!activeRooms[roomId]) {
      activeRooms[roomId] = {};
    }
    activeRooms[roomId][socket.id] = { userId: userId, peerConnections: {} };

    // Notify existing users in the room about the new user
    socket.to(roomId).emit("user-connected", socket.id, userId);

    // Send existing users' IDs to the newly connected user
    const existingUsers = Object.keys(activeRooms[roomId]).filter(
      (id) => id !== socket.id
    );
    socket.emit("existing-users", existingUsers);

    console.log(`User ${userId} (${socket.id}) joined room ${roomId}`);
    console.log("Current room members:", activeRooms[roomId]);

    // Handle incoming chat messages
    socket.on("chat-message", (messageData) => {
      const { message } = messageData; // roomId is implicitly known by the socket's room
      io.to(roomId).emit("chat-message", {
        message: message,
        userId: userId, // Use the provided userId for chat
      });
    });

    // Handle WebRTC signals for specific target users
    socket.on("signal", (data) => {
      const { targetId, signal } = data;
      // Forward the signal to the intended recipient
      if (activeRooms[roomId] && activeRooms[roomId][targetId]) {
        io.to(targetId).emit("signal", {
          senderId: socket.id,
          signal: signal,
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`User ${userId} (${socket.id}) disconnected from room ${roomId}`);
      if (activeRooms[roomId] && activeRooms[roomId][socket.id]) {
        delete activeRooms[roomId][socket.id];
        // Notify other users in the room that this user disconnected
        socket.to(roomId).emit("user-disconnected", socket.id);

        if (Object.keys(activeRooms[roomId]).length === 0) {
          delete activeRooms[roomId]; // Clean up empty rooms
        }
      }
    });

    // Handle explicit disconnect from call button
    socket.on("disconnect-call", () => {
      console.log(`User ${userId} (${socket.id}) left the call from room ${roomId}`);
      if (activeRooms[roomId] && activeRooms[roomId][socket.id]) {
        delete activeRooms[roomId][socket.id];
        socket.to(roomId).emit("user-disconnected", socket.id);

        if (Object.keys(activeRooms[roomId]).length === 0) {
          delete activeRooms[roomId]; // Clean up empty rooms
        }
      }
    });

    // "end-call" event could be used to signify that the room should be dissolved
    // For a group call, this might not be needed unless one user "ends" it for everyone.
    // In a mesh, individual users just leave.
    socket.on("end-call", (roomId) => {
      io.in(roomId).emit("call-ended"); // send to everyone in the room
      if (activeRooms[roomId]) {
        delete activeRooms[roomId]; // Remove the room from active rooms
        console.log(`Room ${roomId} has been ended.`);
      }
    });
  });
});

http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});