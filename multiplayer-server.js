const express = require("express");
const http = require("http");
const crypto = require("crypto");
const cors = require("cors");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const app = express();
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()),
  })
);
app.get("/", (_req, res) => res.type("text").send("Multiplayer server OK"));
app.get("/health", (_req, res) => res.json({ ok: true }));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()) },
  connectTimeout: 45_000,
  pingTimeout: 25_000,
  pingInterval: 10_000,
});
const waitingQueues = new Map(); // key -> [{socket, uid, mode, betAmount}]
const roomStates = new Map(); // room -> state
function perPlayerMsForMode(mode) {
  return mode === "paid" ? 5 * 60 * 1000 : 10 * 60 * 1000;
}
function queueKey(mode, betAmount) {
  return mode === "paid" ? `paid_${Number(betAmount) || 0}` : "free";
}
function createRoomState(room, gameId, mode, betAmount, whiteUid, blackUid) {
  const per = perPlayerMsForMode(mode);
  const st = {
    room,
    gameId,
    mode,
    betAmount,
    isFinished: false,
    chess: new Chess(),
    whiteUid,
    blackUid,
    whiteMs: per,
    blackMs: per,
    toMove: "w",
    turnClockStartedAt: Date.now(),
    disconnectTimeoutId: null,
  };
  roomStates.set(room, st);
  return st;
}
function liveClockPayloadFromState(st) {
  const serverNow = Date.now();
  const elapsed = Math.max(0, serverNow - st.turnClockStartedAt);
  let white = st.whiteMs;
  let black = st.blackMs;
  if (st.toMove === "w") white = Math.max(0, white - elapsed);
  else black = Math.max(0, black - elapsed);
  return {
    room: st.room,
    gameId: st.gameId,
    whiteRemainingMs: white,
    blackRemainingMs: black,
    whiteTime: white,
    blackTime: black,
    sideToMove: st.toMove,
    currentTurn: st.toMove === "w" ? "white" : "black",
    turnClockStartedAt: st.turnClockStartedAt,
    lastMoveTimestamp: st.turnClockStartedAt,
    serverNow,
  };
}
function endMatch(room, payload) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  st.isFinished = true;
  if (st.disconnectTimeoutId) clearTimeout(st.disconnectTimeoutId);
  io.to(room).emit("gameResult", {
    room,
    gameId: st.gameId,
    mode: st.mode,
    betAmount: st.betAmount,
    whiteUid: st.whiteUid,
    blackUid: st.blackUid,
    draw: !!payload.draw,
    winnerColor: payload.winnerColor ?? null,
    reason: payload.reason,
    paid: st.mode === "paid" && st.betAmount > 0,
    balancesByUid: null, // wire wallet logic here if needed
  });
  roomStates.delete(room);
}
function finalizeTimeoutFlag(room) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  const now = Date.now();
  const bank = st.toMove === "w" ? st.whiteMs : st.blackMs;
  const elapsed = Math.max(0, now - st.turnClockStartedAt);
  if (bank - elapsed > 0) return;
  endMatch(room, {
    reason: "timeout",
    winnerColor: st.toMove === "w" ? "black" : "white",
    draw: false,
  });
}
function tickActiveGames() {
  for (const [room, st] of roomStates.entries()) {
    if (!st || st.isFinished) continue;
    const live = liveClockPayloadFromState(st);
    if (st.toMove === "w" && live.whiteRemainingMs <= 0) {
      finalizeTimeoutFlag(room);
      continue;
    }
    if (st.toMove === "b" && live.blackRemainingMs <= 0) {
      finalizeTimeoutFlag(room);
      continue;
    }
    io.to(room).emit("clockSync", live);
    io.to(room).emit("gameState", live);
  }
}
function playerColorFromSocketMeta(meta) {
  if (!meta) return null;
  if (meta.color === "white") return "w";
  if (meta.color === "black") return "b";
  return null;
}
function startDisconnectGrace(room, disconnectedColor) {
  const st = roomStates.get(room);
  if (!st || st.isFinished) return;
  if (st.disconnectTimeoutId) clearTimeout(st.disconnectTimeoutId);
  st.disconnectTimeoutId = setTimeout(() => {
    const s2 = roomStates.get(room);
    if (!s2 || s2.isFinished) return;
    endMatch(room, {
      reason: "disconnect_forfeit",
      winnerColor: disconnectedColor === "white" ? "black" : "white",
      draw: false,
    });
  }, 30_000);
}
io.on("connection", (socket) => {
  socket.on("joinGame", (payload = {}) => {
    const mode = payload.mode === "paid" ? "paid" : "free";
    const betAmount = mode === "paid" ? Math.max(0, Math.floor(Number(payload.betAmount) || 0)) : 0;
    const uid = typeof payload.uid === "string" && payload.uid.length > 0 ? payload.uid : socket.id;
    if (mode === "paid" && betAmount <= 0) {
      socket.emit("matchmaking_error", { message: "Invalid stake for paid match." });
      return;
    }
    const key = queueKey(mode, betAmount);
    if (!waitingQueues.has(key)) waitingQueues.set(key, []);
    const queue = waitingQueues.get(key);
    if (queue.length === 0) {
      queue.push({ socket, uid, mode, betAmount });
      socket.waitingQueueKey = key;
      socket.emit("waiting");
      return;
    }
    const first = queue.shift();
    if (!first?.socket?.connected || first.socket.id === socket.id) {
      socket.emit("matchmaking_error", { message: "Queue entry expired. Try again." });
      return;
    }
    const room = `${first.socket.id}#${socket.id}`;
    const gameId = crypto.randomUUID();
    const whiteUid = first.uid;
    const blackUid = uid;
    first.socket.join(room);
    socket.join(room);
    first.socket.room = room;
    socket.room = room;
    first.socket.matchMeta = { room, color: "white", gameId, mode, betAmount, playerId: whiteUid };
    socket.matchMeta = { room, color: "black", gameId, mode, betAmount, playerId: blackUid };
    const st = createRoomState(room, gameId, mode, betAmount, whiteUid, blackUid);
    const startPayload = (color) => ({
      room,
      color,
      gameId,
      mode,
      betAmount: mode === "paid" ? betAmount : 0,
      whiteUid,
      blackUid,
      clock: liveClockPayloadFromState(st),
    });
    first.socket.emit("start", startPayload("white"));
    socket.emit("start", startPayload("black"));
  });
  socket.on("rejoinMatch", (payload = {}) => {
    const room = typeof payload.room === "string" ? payload.room : "";
    const uid = typeof payload.uid === "string" ? payload.uid : "";
    if (!room || !uid) {
      socket.emit("rejoinFailed", { message: "Invalid rejoin payload." });
      return;
    }
    const st = roomStates.get(room);
    if (!st || st.isFinished) {
      socket.emit("rejoinFailed", { message: "Match not active." });
      return;
    }
    if (uid !== st.whiteUid && uid !== st.blackUid) {
      socket.emit("rejoinFailed", { message: "Not a player in this match." });
      return;
    }
    const color = uid === st.whiteUid ? "white" : "black";
    socket.join(room);
    socket.room = room;
    socket.matchMeta = {
      room,
      color,
      gameId: st.gameId,
      mode: st.mode,
      betAmount: st.betAmount,
      playerId: uid,
    };
    if (st.disconnectTimeoutId) {
      clearTimeout(st.disconnectTimeoutId);
      st.disconnectTimeoutId = null;
    }
    socket.emit("rejoinOk", {
      room,
      color,
      gameId: st.gameId,
      mode: st.mode,
      betAmount: st.betAmount,
      whiteUid: st.whiteUid,
      blackUid: st.blackUid,
      fen: st.chess.fen(),
      moves: st.chess.history(),
      clock: liveClockPayloadFromState(st),
    });
    const live = liveClockPayloadFromState(st);
    io.to(room).emit("clockSync", live);
    io.to(room).emit("gameState", live);
  });
  socket.on("move", (data = {}) => {
    const room = typeof data.room === "string" ? data.room : "";
    if (!room || socket.room !== room || !data?.move) return;
    const st = roomStates.get(room);
    if (!st || st.isFinished || !socket.matchMeta) return;
    const mover = playerColorFromSocketMeta(socket.matchMeta);
    if (!mover || mover !== st.toMove) return;
    const now = Date.now();
    const bank = st.toMove === "w" ? st.whiteMs : st.blackMs;
    const elapsed = Math.max(0, now - st.turnClockStartedAt);
    // Timeout before move arrives -> lose on time
    if (elapsed >= bank) {
      finalizeTimeoutFlag(room);
      return;
    }
    const moveTry = st.chess.move({
      from: data.move.from,
      to: data.move.to,
      promotion: data.move.promotion || "q",
    });
    if (!moveTry) return;
    // Commit mover elapsed time to their bank
    if (st.toMove === "w") st.whiteMs = bank - elapsed;
    else st.blackMs = bank - elapsed;
    st.toMove = st.toMove === "w" ? "b" : "w";
    st.turnClockStartedAt = now;
    io.to(room).emit("move", data.move);
    const live = liveClockPayloadFromState(st);
    io.to(room).emit("clockSync", live);
    io.to(room).emit("gameState", live);
    if (st.chess.isCheckmate()) {
      const loser = st.chess.turn(); // side to move after mate
      endMatch(room, {
        reason: "checkmate",
        winnerColor: loser === "w" ? "black" : "white",
        draw: false,
      });
      return;
    }
    if (st.chess.isDraw()) {
      endMatch(room, { reason: "draw", draw: true, winnerColor: null });
    }
  });
  socket.on("playerResigned", () => {
    const meta = socket.matchMeta;
    if (!meta?.room || !meta?.color) return;
    endMatch(meta.room, {
      reason: "playerResigned",
      winnerColor: meta.color === "white" ? "black" : "white",
      draw: false,
    });
  });
  socket.on("resign", () => {
    const meta = socket.matchMeta;
    if (!meta?.room || !meta?.color) return;
    endMatch(meta.room, {
      reason: "resign",
      winnerColor: meta.color === "white" ? "black" : "white",
      draw: false,
    });
  });
  socket.on("disconnect", () => {
    // remove from queue
    const key = socket.waitingQueueKey;
    if (key && waitingQueues.has(key)) {
      const q = waitingQueues.get(key);
      const idx = q.findIndex((e) => e.socket === socket);
      if (idx >= 0) q.splice(idx, 1);
      if (q.length === 0) waitingQueues.delete(key);
    }
    // apply disconnect grace if in active match
    const meta = socket.matchMeta;
    if (meta?.room && meta?.color) {
      const st = roomStates.get(meta.room);
      if (st && !st.isFinished) startDisconnectGrace(meta.room, meta.color);
    }
  });
});
setInterval(tickActiveGames, 1000);
const PORT = Number(process.env.PORT) || 4000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Multiplayer server listening on ${PORT}`);
});
