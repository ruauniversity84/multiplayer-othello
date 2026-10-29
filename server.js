const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const SIZE = 15;
const COLORS = [
  { id: 1, name: "黒", hex: "#171717" },
  { id: 2, name: "白", hex: "#f5f5f5" },
  { id: 3, name: "赤", hex: "#f04444" },
  { id: 4, name: "青", hex: "#3287ff" }
];
const DIRECTIONS = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
const rooms = new Map();
const socketRoom = new Map();

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({length: 5}, () => chars[crypto.randomInt(chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function cleanName(value) {
  const s = String(value || "").trim().replace(/[<>]/g, "").slice(0, 18);
  return s || "プレイヤー";
}
function activePlayers(room) {
  return COLORS.slice(0, room.playerCount);
}
function playerById(room, id) {
  return room.players.find(p => p.colorId === id);
}
function getFlips(board, x, y, playerId, playerCount) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE || board[y][x] !== 0) return [];
  const flips = [];
  for (const [dx, dy] of DIRECTIONS) {
    let nx = x + dx, ny = y + dy;
    const line = [];
    while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE &&
           board[ny][nx] !== 0 && board[ny][nx] !== playerId) {
      line.push([nx, ny]);
      nx += dx; ny += dy;
    }
    if (line.length && nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE &&
        board[ny][nx] === playerId) flips.push(...line);
  }
  return flips;
}
function legalMoves(room, playerId) {
  const moves = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (getFlips(room.board, x, y, playerId, room.playerCount).length) moves.push([x, y]);
  }
  return moves;
}
function initializeBoard(room) {
  room.board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  const n = room.playerCount;
  const start = Math.floor((SIZE - n) / 2);
  const patterns = {
    // 2人対戦は通常の黒・白の初期配置
    2: [[1,2],[2,1]],
    3: [[1,2,3],[3,1,2],[2,3,1]],
    4: [[1,2,3,4],[3,4,1,2],[2,1,4,3],[4,3,2,1]]
  };
  const pattern = patterns[n];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    room.board[start + y][start + x] = pattern[y][x];
  }
  room.turn = 1;
  room.history = [];
  room.status = "playing";
  room.message = "対局開始！黒の手番です。";
  room.passLog = [];
}
function counts(room) {
  const result = Object.fromEntries(activePlayers(room).map(p => [p.id, 0]));
  for (const row of room.board) for (const cell of row) if (cell) result[cell]++;
  return result;
}
function nextPlayer(room, fromId) {
  // 2人対戦は相手が置けなければ自分が続けて打つ（通常のオセロのパス処理）。
  if (room.playerCount === 2) {
    const opponent = fromId === 1 ? 2 : 1;
    if (legalMoves(room, opponent).length) return opponent;
    if (legalMoves(room, fromId).length) return fromId;
    return null;
  }
  // 3人・4人対戦では、自分以外の次の手番候補を探す。
  for (let step = 1; step < room.playerCount; step++) {
    const id = ((fromId - 1 + step) % room.playerCount) + 1;
    if (legalMoves(room, id).length) return id;
  }
  return null;
}
function snapshot(room) {
  return {
    board: room.board.map(row => row.slice()),
    turn: room.turn,
    status: room.status,
    message: room.message,
    passLog: [...room.passLog]
  };
}
function saveHistory(room) {
  room.history.push(snapshot(room));
  if (room.history.length > 200) room.history.shift();
}
function serialize(room, clientId) {
  const c = counts(room);
  return {
    code: room.code,
    hostClientId: room.hostClientId,
    playerCount: room.playerCount,
    status: room.status,
    message: room.message,
    board: room.board,
    turn: room.turn,
    historyLength: room.history.length,
    counts: c,
    players: room.players.map(p => ({
      clientId: p.clientId,
      name: p.name,
      colorId: p.colorId,
      connected: Boolean(p.socketId),
      isHost: p.clientId === room.hostClientId,
      isMe: p.clientId === clientId
    })),
    me: room.players.find(p => p.clientId === clientId) || null,
    legalMoves: room.status === "playing" && room.turn === (room.players.find(p => p.clientId === clientId)?.colorId)
      ? legalMoves(room, room.turn)
      : []
  };
}
function emitRoom(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit("room-state", serialize(room, p.clientId));
  }
}
function errorTo(socket, message) {
  socket.emit("app-error", message);
}
function getRoomForSocket(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return null;
  return rooms.get(code) || null;
}
function playerForSocket(room, socket) {
  return room?.players.find(p => p.socketId === socket.id) || null;
}
function attachSocket(room, player, socket) {
  if (player.socketId && player.socketId !== socket.id) {
    io.to(player.socketId).emit("session-replaced");
    socketRoom.delete(player.socketId);
  }
  player.socketId = socket.id;
  socketRoom.set(socket.id, room.code);
  socket.join(room.code);
}
function leaveCurrent(socket) {
  const room = getRoomForSocket(socket);
  if (!room) return;
  const player = playerForSocket(room, socket);
  socketRoom.delete(socket.id);
  if (player) {
    player.socketId = null;
    if (room.status === "lobby") {
      room.players = room.players.filter(p => p.clientId !== player.clientId);
      if (!room.players.length) {
        rooms.delete(room.code);
        return;
      }
      if (room.hostClientId === player.clientId) {
        room.hostClientId = room.players[0].clientId;
        room.message = `${room.players[0].name}がホストになりました。`;
      }
    }
  }
  emitRoom(room);
}
function finishIfNoMoves(room) {
  const next = nextPlayer(room, room.turn);
  if (next === null) {
    room.status = "finished";
    const c = counts(room);
    const max = Math.max(...Object.values(c));
    const winners = activePlayers(room).filter(p => c[p.id] === max).map(p => p.name);
    room.message = winners.length === 1
      ? `ゲーム終了：${winners[0]}の勝ち！`
      : `ゲーム終了：${winners.join("・")}の引き分け`;
    return;
  }
  room.turn = next;
}
function requireHost(socket, room) {
  const player = playerForSocket(room, socket);
  if (!player || player.clientId !== room.hostClientId) {
    errorTo(socket, "この操作はホストだけが実行できます。");
    return false;
  }
  return true;
}

io.on("connection", socket => {
  socket.on("create-room", ({ clientId, name, playerCount } = {}) => {
    if (getRoomForSocket(socket)) leaveCurrent(socket);
    if (!clientId || ![2,3,4].includes(Number(playerCount))) return errorTo(socket, "参加人数の設定が不正です。");
    const code = roomCode();
    const host = {
      clientId: String(clientId).slice(0, 80),
      name: cleanName(name),
      colorId: 1,
      socketId: socket.id
    };
    const room = {
      code, hostClientId: host.clientId, playerCount: Number(playerCount),
      players: [host], board: [], turn: 1, history: [], status: "lobby",
      message: "参加者を待っています。ホストが開始できます。", passLog: []
    };
    initializeBoard(room);
    room.status = "lobby";
    room.message = "参加者を待っています。";
    rooms.set(code, room);
    attachSocket(room, host, socket);
    emitRoom(room);
  });

  socket.on("join-room", ({ clientId, name, code } = {}) => {
    if (getRoomForSocket(socket)) leaveCurrent(socket);
    const normalizedCode = String(code || "").trim().toUpperCase();
    const room = rooms.get(normalizedCode);
    if (!room) return errorTo(socket, "部屋が見つかりません。コードを確認してください。");
    if (!clientId) return errorTo(socket, "端末識別情報を取得できません。ページを再読み込みしてください。");
    const cid = String(clientId).slice(0, 80);
    let existing = room.players.find(p => p.clientId === cid);
    if (existing) {
      attachSocket(room, existing, socket);
      room.message = `${existing.name}が再接続しました。`;
      emitRoom(room);
      return;
    }
    if (room.status !== "lobby") return errorTo(socket, "この対局は開始済みです。新しい部屋を作成してください。");
    if (room.players.length >= room.playerCount) return errorTo(socket, "この部屋は満員です。");
    const used = new Set(room.players.map(p => p.colorId));
    const colorId = activePlayers(room).find(p => !used.has(p.id)).id;
    const player = { clientId: cid, name: cleanName(name), colorId, socketId: socket.id };
    room.players.push(player);
    attachSocket(room, player, socket);
    room.message = `${player.name}（${player.name ? COLORS[colorId-1].name : ""}）が参加しました。`;
    emitRoom(room);
  });

  socket.on("set-player-count", ({ playerCount } = {}) => {
    const room = getRoomForSocket(socket);
    if (!room || !requireHost(socket, room)) return;
    if (room.status !== "lobby") return errorTo(socket, "対局開始後は人数を変更できません。");
    const n = Number(playerCount);
    if (![2,3,4].includes(n)) return errorTo(socket, "2人、3人、または4人を選択してください。");
    if (room.players.length > n) return errorTo(socket, "参加者が多すぎます。先に参加者に退出してもらってください。");
    room.playerCount = n;
    room.players.forEach((p, i) => { p.colorId = i + 1; });
    room.message = `対戦人数を${n}人に設定しました。`;
    emitRoom(room);
  });

  socket.on("start-game", () => {
    const room = getRoomForSocket(socket);
    if (!room || !requireHost(socket, room)) return;
    if (room.status !== "lobby") return errorTo(socket, "この対局はすでに開始されています。");
    if (room.players.length !== room.playerCount) return errorTo(socket, `開始するには${room.playerCount}人全員の参加が必要です。`);
    initializeBoard(room);
    room.message = "対局開始！黒の手番です。";
    emitRoom(room);
  });

  socket.on("move", ({ x, y } = {}) => {
    const room = getRoomForSocket(socket);
    const player = room && playerForSocket(room, socket);
    if (!room || !player) return errorTo(socket, "部屋に参加していません。");
    if (room.status !== "playing") return errorTo(socket, "対局中ではありません。");
    if (player.colorId !== room.turn) return errorTo(socket, "あなたの手番ではありません。");
    x = Number(x); y = Number(y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    const flips = getFlips(room.board, x, y, room.turn, room.playerCount);
    if (!flips.length) return errorTo(socket, "そこには置けません。薄い緑の点があるマスを選んでください。");
    saveHistory(room);
    const played = room.turn;
    room.board[y][x] = played;
    for (const [fx, fy] of flips) room.board[fy][fx] = played;
    const next = nextPlayer(room, played);
    if (next === null) {
      room.status = "finished";
      const c = counts(room);
      const max = Math.max(...Object.values(c));
      const winners = activePlayers(room).filter(p => c[p.id] === max).map(p => p.name);
      room.message = winners.length === 1 ? `ゲーム終了：${winners[0]}の勝ち！` : `ゲーム終了：${winners.join("・")}の引き分け`;
    } else {
      const skipped = [];
      let id = (played % room.playerCount) + 1;
      while (id !== next) {
        skipped.push(playerById(room, id)?.name || COLORS[id - 1].name);
        id = (id % room.playerCount) + 1;
      }
      room.turn = next;
      room.message = skipped.length
        ? `${skipped.join("・")}は置けないためパス。${playerById(room, next)?.name}の手番です。`
        : `${playerById(room, next)?.name}の手番です。`;
    }
    emitRoom(room);
  });

  socket.on("pass", () => {
    const room = getRoomForSocket(socket);
    const player = room && playerForSocket(room, socket);
    if (!room || !player || room.status !== "playing") return;
    if (player.colorId !== room.turn) return errorTo(socket, "あなたの手番ではありません。");
    if (legalMoves(room, room.turn).length) return errorTo(socket, "置ける場所があるためパスできません。");
    saveHistory(room);
    const oldName = player.name;
    const next = nextPlayer(room, room.turn);
    if (next === null) {
      room.status = "finished";
      const c = counts(room), max = Math.max(...Object.values(c));
      const winners = activePlayers(room).filter(p => c[p.id] === max).map(p => p.name);
      room.message = winners.length === 1 ? `ゲーム終了：${winners[0]}の勝ち！` : `ゲーム終了：${winners.join("・")}の引き分け`;
    } else {
      room.turn = next;
      room.message = `${oldName}はパス。${playerById(room, next)?.name}の手番です。`;
    }
    emitRoom(room);
  });

  socket.on("undo", () => {
    const room = getRoomForSocket(socket);
    if (!room || !requireHost(socket, room)) return;
    if (room.status === "lobby") return errorTo(socket, "対局開始後に利用できます。");
    if (!room.history.length) return errorTo(socket, "戻せる手がありません。");
    const previous = room.history.pop();
    room.board = previous.board.map(row => row.slice());
    room.turn = previous.turn;
    room.status = previous.status;
    room.message = `${playerById(room, room.turn)?.name || COLORS[room.turn-1].name}の手番に戻しました。`;
    room.passLog = [...previous.passLog];
    emitRoom(room);
  });

  socket.on("new-game", () => {
    const room = getRoomForSocket(socket);
    if (!room || !requireHost(socket, room)) return;
    if (room.players.length !== room.playerCount) return errorTo(socket, `新しいゲームを始めるには${room.playerCount}人全員の接続が必要です。`);
    initializeBoard(room);
    room.message = "ホストが新しいゲームを開始しました。黒の手番です。";
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    const room = getRoomForSocket(socket);
    socketRoom.delete(socket.id);
    if (!room) return;
    const player = playerForSocket(room, socket);
    if (player) player.socketId = null;
    room.message = player ? `${player.name}の接続が切れました。再接続を待っています。` : room.message;
    emitRoom(room);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Online Othello server listening on port ${PORT}`);
});
