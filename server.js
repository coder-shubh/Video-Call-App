// index.js (No changes from previous good version)
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// Store active users in rooms
// Structure: { roomId: { socketId: { userId: string (user's chosen name) }, ... } }
const activeRooms = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomId, userId) => {
    socket.join(roomId);
    if (!activeRooms[roomId]) {
      activeRooms[roomId] = {};
    }
    // Store both socket.id and the chosen userId (display name)
    activeRooms[roomId][socket.id] = { userId: userId };

    // Notify existing users in the room about the new user, sending both socket.id and their chosen name
    socket.to(roomId).emit("user-connected", socket.id, userId);

    // Send existing users' IDs AND names to the newly connected user
    const existingUsers = Object.keys(activeRooms[roomId])
      .filter((id) => id !== socket.id)
      .map((id) => ({ id: id, name: activeRooms[roomId][id].userId })); // Send object with id and name
    socket.emit("existing-users", existingUsers);

    console.log(`User ${userId} (${socket.id}) joined room ${roomId}`);
    console.log("Current room members in room", roomId, ":", activeRooms[roomId]);

    // Handle incoming chat messages
    socket.on("chat-message", (messageData) => {
      const { message } = messageData;
      // Get the display name of the sender from activeRooms
      // Need to find the room first since the socket might be in multiple rooms if not handled carefully
      // For this setup, a socket only joins one room, so we can iterate or use socket.rooms
      let currentRoomId = null;
      for (const room of socket.rooms) {
          if (room !== socket.id) { // Exclude the default room which is the socket ID
              currentRoomId = room;
              break;
          }
      }

      if (currentRoomId && activeRooms[currentRoomId]) {
          const senderName = activeRooms[currentRoomId][socket.id]?.userId || "Unknown User";
          io.to(currentRoomId).emit("chat-message", {
            message: message,
            userId: senderName, // Use the display name for chat
          });
      } else {
          console.warn(`Chat message received from socket ${socket.id} not associated with a known room.`);
      }
    });

    // Handle WebRTC signals for specific target users
    socket.on("signal", (data) => {
      const { targetId, signal } = data;
      // Forward the signal to the intended recipient, indicating the original sender's socket.id
      // Ensure targetId is in the same room (though socket.io handles direct emits to specific sockets)
      if (activeRooms[roomId] && activeRooms[roomId][targetId]) {
        io.to(targetId).emit("signal", {
          senderId: socket.id,
          signal: signal,
        });
      } else {
        console.warn(`Signal for unknown targetId ${targetId} in room ${roomId} from ${socket.id}`);
      }
    });

    socket.on("disconnect", () => {
      console.log(`Socket ${socket.id} disconnected.`);
      // Find which room the socket was in and remove them
      for (const room in activeRooms) {
        if (activeRooms[room][socket.id]) {
          const disconnectedUserName = activeRooms[room][socket.id].userId;
          delete activeRooms[room][socket.id];
          // Notify other users in that room that this user disconnected
          socket.to(room).emit("user-disconnected", disconnectedUserName || socket.id); // Send name if available
          console.log(`User ${disconnectedUserName || socket.id} removed from room ${room}`);

          if (Object.keys(activeRooms[room]).length === 0) {
            delete activeRooms[room]; // Clean up empty rooms
            console.log(`Room ${room} is now empty and deleted.`);
          }
          break; // User can only be in one room in this simple setup
        }
      }
    });

    // Handle explicit disconnect from call button
    socket.on("disconnect-call", () => {
      // This event comes from the client when they click "Leave Call"
      // It's similar to a disconnect but can be handled explicitly for UI feedback.
      socket.disconnect(true); // Force a full disconnect, which will trigger the 'disconnect' event above
    });

    // "end-call" event could be used to signify that the room should be dissolved
    // For a group call, this might not be needed unless one user "ends" it for everyone.
    // In a mesh, individual users just leave.
    socket.on("end-call", (roomId) => { // This roomId will be from the client, ensure it's valid
      io.in(roomId).emit("call-ended"); // send to everyone in the room
      if (activeRooms[roomId]) {
        delete activeRooms[roomId]; // Remove the room from active rooms
        console.log(`Room ${roomId} has been ended by a user.`);
      }
    });
  });
});

http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});