const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Handle joining a room
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit("user-connected", socket.id);

    // Handle incoming chat messages
    socket.on("chat-message", (messageData) => {
      const { message, roomId } = messageData;
      io.to(roomId).emit("chat-message", { message: message, userId: socket.id });
    });

    // Handle other events
    socket.on("signal", (data) => {
      socket.to(roomId).emit("signal", { id: socket.id, signal: data });
    });

    socket.on("disconnect-call", (roomId) => {
      socket.to(roomId).emit("user-disconnected", socket.id);
    });

    socket.on("disconnect", () => {
      socket.to(roomId).emit("user-disconnected", socket.id);
    });

    socket.on("end-call", (roomId) => {
      io.in(roomId).emit("call-ended"); // send to everyone in the room
    });
  });
});


http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
