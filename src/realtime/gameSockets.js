const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { attachMonopoly, handleMonopolyDisconnect } = require("./monopoly");

// ==========================================================
// Real-time multiplayer arcade — Rock-Paper-Scissors, Tic-Tac-Toe,
// Snake & Ladder, and Ludo, played by challenging a specific friend
// (rather than the old site's manual "type in a room code" flow).
//
// Every match lives entirely in memory (a Map keyed by roomId) — same as
// the old site's game rooms. Nothing here is persisted to the database:
// a server restart drops in-progress matches, which is an acceptable
// trade-off for a live 1v1 game and keeps this simple.
// ==========================================================

const GAME_SLUGS = ["rps", "tictactoe", "snakeandladder", "ludo"];
const CHALLENGE_TIMEOUT_MS = 60 * 1000;

// --- ROCK PAPER SCISSORS ---
const RPS_BEATS = { ROCK: "SCISSORS", PAPER: "ROCK", SCISSORS: "PAPER" };

// --- TIC-TAC-TOE ---
const WINNING_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
function checkTttWinner(board) {
  for (const [a, b, c] of WINNING_COMBOS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (!board.includes(null)) return "DRAW";
  return null;
}

// --- SNAKE & LADDER ---
const SNAKES = { 16: 6, 46: 25, 49: 11, 62: 19, 64: 60, 74: 53, 89: 68, 92: 88, 95: 75, 99: 80 };
const LADDERS = { 2: 38, 7: 14, 8: 31, 15: 26, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 78: 98 };

// --- LUDO ---
const LUDO_TRACK_LENGTH = 52;
const LUDO_HOME_STRETCH = 6;
const LUDO_TOTAL_STEPS = LUDO_TRACK_LENGTH + LUDO_HOME_STRETCH; // step index 57 = finished
const LUDO_START_OFFSETS = [0, 13, 26, 39];
const LUDO_SAFE_SQUARES = [0, 8, 13, 21, 26, 34, 39, 47];
const LUDO_COLORS = ["red", "green", "yellow", "blue"];

function ludoAbsolutePos(seat, step) {
  if (step >= LUDO_TRACK_LENGTH - 1) return null;
  return (LUDO_START_OFFSETS[seat] + step) % LUDO_TRACK_LENGTH;
}

// --- Per-game initial state ---
function initGame(gameSlug, playerCount) {
  switch (gameSlug) {
    case "rps":
      return { moves: {}, scores: Array(playerCount).fill(0) };
    case "tictactoe":
      return { board: Array(9).fill(null), turn: 0, scores: Array(playerCount).fill(0) };
    case "snakeandladder":
      return { positions: Array(playerCount).fill(0), turn: 0, winner: null };
    case "ludo":
      return {
        tokens: Array.from({ length: playerCount }, () => [0, 0, 0, 0]),
        turn: 0,
        winner: null,
        lastRoll: null,
        extraTurnPending: false,
        colors: LUDO_COLORS.slice(0, playerCount),
      };
    default:
      return {};
  }
}

function sanitizePlayer(p) {
  return { userId: p.userId, username: p.username, name: p.name, avatarUrl: p.avatarUrl };
}

function attachGameSockets(io) {
  // roomId -> { gameSlug, status: "pending"|"playing", fromUserId, invitedUserId,
  //             players: [{userId, socketId, username, name, avatarUrl}], game, timeout }
  const rooms = new Map();
  // userId -> Set<socketId> — who's currently connected, for challenge delivery.
  const onlineSockets = new Map();
  // Monopoly is lobby-based rather than challenge-based: joinCode -> roomId.
  const codes = new Map();

  function addOnline(userId, socketId) {
    if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
    onlineSockets.get(userId).add(socketId);
  }
  function removeOnline(userId, socketId) {
    const set = onlineSockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) onlineSockets.delete(userId);
  }

  function seatOf(room, userId) {
    return room.players.findIndex((p) => p.userId === userId);
  }

  function roomChannel(roomId) {
    return `room:${roomId}`;
  }

  function destroyRoom(roomId) {
    const room = rooms.get(roomId);
    if (room?.timeout) clearTimeout(room.timeout);
    rooms.delete(roomId);
  }

  // JWT auth handshake — mirrors src/middleware/auth.js, but for sockets.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("unauthorized"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, username: true, name: true, avatarUrl: true, deletedAt: true },
      });
      if (!user || user.deletedAt) return next(new Error("unauthorized"));
      socket.userId = user.id;
      socket.userInfo = { userId: user.id, username: user.username, name: user.name, avatarUrl: user.avatarUrl };
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    addOnline(socket.userId, socket.id);

    // Monopoly runs its own lobby + engine (realtime/monopoly.js) on top of
    // this same authenticated socket and the shared `rooms` Map.
    attachMonopoly(io, socket, { rooms, codes, roomChannel });

    // ------------------------------------------
    // DM TYPING INDICATOR — piggybacks on this same authenticated socket
    // and its online-user tracking rather than opening a second
    // connection; read receipts themselves are plain HTTP (see
    // message.controller.js's getThread), this is only the live
    // "...is typing" signal.
    // ------------------------------------------
    socket.on("dm:typing", ({ toUserId }) => {
      const targets = onlineSockets.get(toUserId);
      if (!targets) return;
      for (const sid of targets) io.to(sid).emit("dm:typing", { fromUserId: socket.userId });
    });

    socket.on("dm:stop_typing", ({ toUserId }) => {
      const targets = onlineSockets.get(toUserId);
      if (!targets) return;
      for (const sid of targets) io.to(sid).emit("dm:stop_typing", { fromUserId: socket.userId });
    });

    // ------------------------------------------
    // CHALLENGE FLOW
    // ------------------------------------------
    socket.on("challenge:send", ({ toUserId, gameSlug }, ack) => {
      if (typeof ack !== "function") return;
      if (!GAME_SLUGS.includes(gameSlug)) return ack({ ok: false, error: "bad_game" });
      if (!toUserId || toUserId === socket.userId) return ack({ ok: false, error: "bad_target" });

      const targetSockets = onlineSockets.get(toUserId);
      if (!targetSockets || targetSockets.size === 0) {
        return ack({ ok: false, error: "offline" });
      }

      const roomId = crypto.randomBytes(4).toString("hex");
      const me = { ...socket.userInfo, socketId: socket.id };
      const room = {
        gameSlug,
        status: "pending",
        fromUserId: socket.userId,
        invitedUserId: toUserId,
        players: [me],
        game: null,
        timeout: null,
      };
      rooms.set(roomId, room);
      socket.join(roomChannel(roomId));

      room.timeout = setTimeout(() => {
        const stillPending = rooms.get(roomId);
        if (!stillPending || stillPending.status !== "pending") return;
        io.to(roomChannel(roomId)).emit("challenge:expired", { roomId });
        destroyRoom(roomId);
      }, CHALLENGE_TIMEOUT_MS);

      for (const sid of targetSockets) {
        io.to(sid).emit("challenge:incoming", {
          roomId,
          gameSlug,
          from: sanitizePlayer(me),
        });
      }

      ack({ ok: true, roomId, you: sanitizePlayer(me) });
    });

    socket.on("challenge:cancel", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.fromUserId !== socket.userId || room.status !== "pending") return;
      io.to(roomChannel(roomId)).emit("challenge:canceled", { roomId });
      destroyRoom(roomId);
    });

    socket.on("challenge:decline", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.invitedUserId !== socket.userId || room.status !== "pending") return;
      io.to(roomChannel(roomId)).emit("challenge:declined", { roomId });
      destroyRoom(roomId);
    });

    socket.on("challenge:accept", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.invitedUserId !== socket.userId || room.status !== "pending") return;

      clearTimeout(room.timeout);
      room.timeout = null;
      room.players.push({ ...socket.userInfo, socketId: socket.id });
      socket.join(roomChannel(roomId));
      room.status = "playing";
      room.game = initGame(room.gameSlug, room.players.length);

      const sanitizedPlayers = room.players.map(sanitizePlayer);
      room.players.forEach((p, seat) => {
        io.to(p.socketId).emit("challenge:accepted", {
          roomId,
          gameSlug: room.gameSlug,
          seat,
          players: sanitizedPlayers,
          game: room.game,
        });
      });
    });

    // ------------------------------------------
    // ROCK PAPER SCISSORS
    // ------------------------------------------
    socket.on("rps:move", ({ roomId, weaponKey }) => {
      const room = rooms.get(roomId);
      if (!room || room.gameSlug !== "rps" || room.status !== "playing") return;
      if (!RPS_BEATS[weaponKey]) return;
      const seat = seatOf(room, socket.userId);
      if (seat === -1 || room.game.moves[seat]) return;

      room.game.moves[seat] = weaponKey;
      socket.to(roomChannel(roomId)).emit("rps:opponent_moved", { seat });

      const seats = room.players.map((_, i) => i);
      if (seats.every((s) => room.game.moves[s])) {
        const [a, b] = seats;
        let winnerSeat = null;
        if (room.game.moves[a] !== room.game.moves[b]) {
          winnerSeat = RPS_BEATS[room.game.moves[a]] === room.game.moves[b] ? a : b;
          room.game.scores[winnerSeat]++;
        }
        io.to(roomChannel(roomId)).emit("rps:result", {
          moves: room.game.moves,
          winnerSeat,
          scores: room.game.scores,
        });
        room.game.moves = {};
      }
    });

    // ------------------------------------------
    // TIC-TAC-TOE
    // ------------------------------------------
    socket.on("ttt:move", ({ roomId, index }) => {
      const room = rooms.get(roomId);
      if (!room || room.gameSlug !== "tictactoe" || room.status !== "playing") return;
      const seat = seatOf(room, socket.userId);
      if (seat === -1 || seat !== room.game.turn) return;
      if (room.game.board[index] !== null || index < 0 || index > 8) return;

      const symbol = seat === 0 ? "X" : "O";
      room.game.board[index] = symbol;
      const result = checkTttWinner(room.game.board);

      if (result) {
        let winnerSeat = null;
        if (result === "X") winnerSeat = 0;
        else if (result === "O") winnerSeat = 1;
        if (winnerSeat !== null) room.game.scores[winnerSeat]++;

        io.to(roomChannel(roomId)).emit("ttt:result", {
          board: room.game.board,
          winnerSeat,
          scores: room.game.scores,
        });
      } else {
        room.game.turn = seat === 0 ? 1 : 0;
        io.to(roomChannel(roomId)).emit("ttt:update", {
          board: room.game.board,
          turn: room.game.turn,
        });
      }
    });

    // ------------------------------------------
    // SNAKE & LADDER
    // ------------------------------------------
    socket.on("snl:roll", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.gameSlug !== "snakeandladder" || room.status !== "playing") return;
      if (room.game.winner !== null) return;
      const seat = seatOf(room, socket.userId);
      if (seat === -1 || seat !== room.game.turn) return;

      const roll = Math.floor(Math.random() * 6) + 1;
      let newPos = room.game.positions[seat] + roll;
      let bust = false;
      if (newPos > 100) {
        bust = true;
        newPos = room.game.positions[seat];
      } else if (SNAKES[newPos]) {
        newPos = SNAKES[newPos];
      } else if (LADDERS[newPos]) {
        newPos = LADDERS[newPos];
      }
      room.game.positions[seat] = newPos;

      let winnerSeat = null;
      if (newPos === 100) {
        winnerSeat = seat;
        room.game.winner = seat;
      }

      const extraTurn = roll === 6 && winnerSeat === null;
      if (!extraTurn) {
        room.game.turn = (room.game.turn + 1) % room.players.length;
      }

      io.to(roomChannel(roomId)).emit("snl:result", {
        seat,
        roll,
        bust,
        positions: room.game.positions,
        turn: room.game.turn,
        winnerSeat,
      });
    });

    // ------------------------------------------
    // LUDO
    // ------------------------------------------
    socket.on("ludo:roll", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.gameSlug !== "ludo" || room.status !== "playing") return;
      if (room.game.winner !== null) return;
      const seat = seatOf(room, socket.userId);
      if (seat === -1 || seat !== room.game.turn) return;
      if (room.game.lastRoll !== null && !room.game.extraTurnPending) return;

      const roll = Math.floor(Math.random() * 6) + 1;
      room.game.lastRoll = roll;
      room.game.extraTurnPending = false;

      const myTokens = room.game.tokens[seat];
      const hasMove = myTokens.some((step) => {
        if (step === 0) return roll === 6;
        return step + roll <= LUDO_TOTAL_STEPS - 1;
      });

      if (!hasMove) {
        room.game.lastRoll = null;
        room.game.turn = (room.game.turn + 1) % room.players.length;
        io.to(roomChannel(roomId)).emit("ludo:roll_result", {
          seat,
          roll,
          noMove: true,
          turn: room.game.turn,
          tokens: room.game.tokens,
        });
        return;
      }

      io.to(roomChannel(roomId)).emit("ludo:roll_result", {
        seat,
        roll,
        noMove: false,
        turn: room.game.turn,
        tokens: room.game.tokens,
      });
    });

    socket.on("ludo:move_token", ({ roomId, tokenIndex }) => {
      const room = rooms.get(roomId);
      if (!room || room.gameSlug !== "ludo" || room.status !== "playing") return;
      if (room.game.winner !== null) return;
      const seat = seatOf(room, socket.userId);
      if (seat === -1 || seat !== room.game.turn) return;
      if (room.game.lastRoll === null) return;

      const roll = room.game.lastRoll;
      const myTokens = room.game.tokens[seat];
      const currentStep = myTokens[tokenIndex];
      if (currentStep === undefined) return;
      if (currentStep === 0 && roll !== 6) return;
      const newStep = currentStep + roll;
      if (newStep > LUDO_TOTAL_STEPS - 1) return;

      myTokens[tokenIndex] = newStep;

      let captured = null;
      const abs = ludoAbsolutePos(seat, newStep);
      if (abs !== null && !LUDO_SAFE_SQUARES.includes(abs)) {
        for (let otherSeat = 0; otherSeat < room.players.length; otherSeat++) {
          if (otherSeat === seat) continue;
          room.game.tokens[otherSeat].forEach((otherStep, otherIdx) => {
            const otherAbs = ludoAbsolutePos(otherSeat, otherStep);
            if (otherAbs !== null && otherAbs === abs) {
              room.game.tokens[otherSeat][otherIdx] = 0;
              captured = { seat: otherSeat, tokenIndex: otherIdx };
            }
          });
        }
      }

      const allHome = myTokens.every((s) => s === LUDO_TOTAL_STEPS - 1);
      let winnerSeat = null;
      if (allHome) {
        winnerSeat = seat;
        room.game.winner = seat;
      }

      const extraTurn = (roll === 6 || captured) && winnerSeat === null;
      room.game.lastRoll = null;
      room.game.extraTurnPending = extraTurn;
      if (!extraTurn) {
        room.game.turn = (room.game.turn + 1) % room.players.length;
      }

      io.to(roomChannel(roomId)).emit("ludo:move_applied", {
        seat,
        tokenIndex,
        tokens: room.game.tokens,
        captured,
        turn: room.game.turn,
        extraTurn,
        winnerSeat,
      });
    });

    // ------------------------------------------
    // REMATCH / LEAVE (shared across all four games)
    // ------------------------------------------
    socket.on("game:rematch", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== "playing") return;
      // Keep scores for rps/tictactoe (best-of-many across rounds); reset
      // board/board-like state only. Snake & Ladder / Ludo have no running
      // score, so a rematch just resets the whole board.
      const scores = room.game.scores;
      room.game = initGame(room.gameSlug, room.players.length);
      if (scores) room.game.scores = scores;
      io.to(roomChannel(roomId)).emit("game:rematch_start", { game: room.game });
    });

    socket.on("game:leave", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      socket.to(roomChannel(roomId)).emit("game:opponent_left", { roomId });
      destroyRoom(roomId);
    });

    // ------------------------------------------
    // DISCONNECT
    // ------------------------------------------
    socket.on("disconnect", () => {
      removeOnline(socket.userId, socket.id);

      for (const [roomId, room] of rooms.entries()) {
        const inRoom = room.players.some((p) => p.socketId === socket.id);
        if (!inRoom) continue;

        // Monopoly games survive a dropped player (they keep their seat and
        // can be skipped or reconnect) rather than ending the whole table.
        if (room.gameSlug === "monopoly") {
          handleMonopolyDisconnect(io, socket, { rooms, codes, roomChannel }, roomId, room);
          continue;
        }

        if (room.status === "pending") {
          // The challenger's tab closed before the invite was answered.
          io.to(roomChannel(roomId)).emit("challenge:canceled", { roomId });
        } else {
          io.to(roomChannel(roomId)).emit("game:opponent_left", { roomId, disconnected: true });
        }
        destroyRoom(roomId);
      }
    });
  });
}

module.exports = { attachGameSockets, GAME_SLUGS };
