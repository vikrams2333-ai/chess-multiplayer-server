const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

let waitingPlayer = null;

io.on("connection", (socket) => {

  console.log("Player connected:", socket.id);

  socket.on("joinGame", () => {

    if (waitingPlayer) {

      const room = waitingPlayer.id + "#" + socket.id;

      socket.join(room);
      waitingPlayer.join(room);

      socket.room = room;
      waitingPlayer.room = room;      

      socket.emit("start", { room, color: "black" });
      waitingPlayer.emit("start", { room, color: "white" });

      waitingPlayer = null;

    } else {

      waitingPlayer = socket;
      socket.emit("waiting");

    }

  });

  socket.on("move", (data) => {

  console.log("MOVE FROM PLAYER:", data);

  io.to(socket.room).emit("move", data.move);

});

  socket.on("disconnect", () => {

    console.log("Player disconnected");

    if (waitingPlayer === socket) {
      waitingPlayer = null;
    }

  });

});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log("Multiplayer server running on port", PORT);
});
