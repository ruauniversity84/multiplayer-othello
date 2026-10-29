
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const COLORS = [
  { id: 1, name: "黒", hex: "#171717" },
  { id: 2, name: "白", hex: "#f5f5f5" },
  { id: 3, name: "赤", hex: "#f04444" },
  { id: 4, name: "青", hex: "#3287ff" }
];

const DIRECTIONS = [
  [-1,-1], [0,-1], [1,-1],
  [-1,0],           [1,0],
  [-1,1],  [0,1],  [1,1]
];

const rooms = new Map();
const socketRoom = new Map();

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function validCode(code) {
  return /^[\p{L}\p{N}_-]{2,20}$/u.test(code);
}

function cleanName(value) {
  return String(value || "").trim().replace(/[<>]/g, "").slice(0, 18) || "プレイヤー";
}

function cleanMessage(value) {
  return String(value || "").trim().slice(0, 300);
}

function activePlayers(room) {
  return COLORS.slice(0, room.playerCount);
}

function playerById(room, id) {
  return room.players.find(p => p.colorId === id);
}

function playerForSocket(room, socket) {
  return room?.players.find(p => p.socketId === socket.id) || null;
}

function getRoomForSocket(socket) {
  const code = socketRoom.get(socket.id);
  return code ? (rooms.get(code) || null) : null;
}

function addChat(room, text, player = null, system = false) {
  room.chat.push({
    id: `${Date.now()}-${Math.random()}`,
    name: player ? player.name : "システム",
    colorId: player?.colorId || 0,
    text,
    system,
    time: Date.now()
  });

  if (room.chat.length > 100) room.chat.shift();
}

function getFlips(board, x, y, playerId) {
  const size = board.length;

  if (
    x < 0 || x >= size ||
    y < 0 || y >= size ||
    board[y][x] !== 0
  ) {
    return [];
  }

  const flips = [];

  for (const [dx, dy] of DIRECTIONS) {
    let nx = x + dx;
    let ny = y + dy;
    const line = [];

    while (
      nx >= 0 && nx < size &&
      ny >= 0 && ny < size &&
      board[ny][nx] !== 0 &&
      board[ny][nx] !== playerId
    ) {
      line.push([nx, ny]);
      nx += dx;
      ny += dy;
    }

    if (
      line.length &&
      nx >= 0 && nx < size &&
      ny >= 0 && ny < size &&
      board[ny][nx] === playerId
    ) {
      flips.push(...line);
    }
  }

  return flips;
}

function legalMoves(room, playerId) {
  const moves = [];

  for (let y = 0; y < room.boardSize; y++) {
    for (let x = 0; x < room.boardSize; x++) {
      if (getFlips(room.board, x, y, playerId).length) {
        moves.push([x, y]);
      }
    }
  }

  return moves;
}

function initializeBoard(room) {
  const size = room.boardSize;

  room.board = Array.from(
    { length: size },
    () => Array(size).fill(0)
  );

  const n = room.playerCount;
  const start = Math.floor((size - n) / 2);

  const patterns = {
    2: [
      [1, 2],
      [2, 1]
    ],
    3: [
      [1, 2, 3],
      [3, 1, 2],
      [2, 3, 1]
    ],
    4: [
      [1, 2, 3, 4],
      [3, 4, 1, 2],
      [2, 1, 4, 3],
      [4, 3, 2, 1]
    ]
  };

  const pattern = patterns[n];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      room.board[start + y][start + x] = pattern[y][x];
    }
  }

  room.turn = 1;
  room.history = [];
  room.status = "playing";
  room.message = "対局開始！黒の手番です。";
}

function counts(room) {
  const result = Object.fromEntries(
    activePlayers(room).map(p => [p.id, 0])
  );

  for (const row of room.board) {
    for (const cell of row) {
      if (cell) result[cell]++;
    }
  }

  return result;
}

function nextPlayer(room, fromId) {
  // 2人対戦は通常のオセロの手番処理
  if (room.playerCount === 2) {
    const opponent = fromId === 1 ? 2 : 1;

    if (legalMoves(room, opponent).length) {
      return opponent;
    }

    if (legalMoves(room, fromId).length) {
      return fromId;
    }

    return null;
  }

  // 3人・4人対戦では次に置けるプレイヤーを探す
  for (let step = 1; step < room.playerCount; step++) {
    const id = ((fromId - 1 + step) % room.playerCount) + 1;

    if (legalMoves(room, id).length) {
      return id;
    }
  }

  return null;
}

function snapshot(room) {
  return {
    board: room.board.map(row => row.slice()),
    turn: room.turn,
    status: room.status,
    message: room.message
  };
}

function saveHistory(room) {
  room.history.push(snapshot(room));

  if (room.history.length > 200) {
    room.history.shift();
  }
}

function finishGame(room) {
  room.status = "finished";

  const c = counts(room);
  const max = Math.max(...Object.values(c));

  const winners = activePlayers(room)
    .filter(p => c[p.id] === max)
    .map(p => playerById(room, p.id)?.name || p.name);

  room.message = winners.length === 1
    ? `ゲーム終了：${winners[0]}の勝ち！`
    : `ゲーム終了：${winners.join("・")}の引き分け`;

  addChat(room, room.message, null, true);
}

function serialize(room, clientId) {
  const me = room.players.find(p => p.clientId === clientId) || null;

  return {
    code: room.code,
    hostClientId: room.hostClientId,
    playerCount: room.playerCount,
    boardSize: room.boardSize,
    status: room.status,
    message: room.message,
    board: room.board,
    turn: room.turn,
    historyLength: room.history.length,
    counts: counts(room),
    chat: room.chat,

    players: room.players.map(p => ({
      clientId: p.clientId,
      name: p.name,
      colorId: p.colorId,
      connected: Boolean(p.socketId),
      isHost: p.clientId === room.hostClientId,
      isMe: p.clientId === clientId
    })),

    me,

    legalMoves:
      room.status === "playing" && room.turn === me?.colorId
        ? legalMoves(room, room.turn)
        : []
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit(
        "room-state",
        serialize(room, p.clientId)
      );
    }
  }
}

function errorTo(socket, message) {
  socket.emit("app-error", message);
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
  socket.leave(room.code);

  if (player) {
    player.socketId = null;

    if (room.status === "lobby") {
      room.players = room.players.filter(
        p => p.clientId !== player.clientId
      );

      if (!room.players.length) {
        rooms.delete(room.code);
        return;
      }

      if (room.hostClientId === player.clientId) {
        room.hostClientId = room.players[0].clientId;
        room.message = `${room.players[0].name}がホストになりました。`;
      }

      addChat(room, `${player.name}が退出しました。`, null, true);
    } else {
      addChat(
        room,
        `${player.name}が退出しました。再接続できます。`,
        null,
        true
      );
    }
  }

  emitRoom(room);
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

  // 部屋作成
  socket.on("create-room", ({
    clientId,
    name,
    playerCount,
    boardSize,
    code
  } = {}) => {
    if (getRoomForSocket(socket)) leaveCurrent(socket);

    const cid = String(clientId || "").slice(0, 80);
    const normalizedCode = normalizeCode(code);
    const count = Number(playerCount);
    const size = Number(boardSize);

    if (!cid) {
      return errorTo(socket, "端末識別情報を取得できません。再読み込みしてください。");
    }

    if (!validCode(normalizedCode)) {
      return errorTo(socket, "部屋コードは2〜20文字の日本語・英数字・_・-で指定してください。");
    }

    if (rooms.has(normalizedCode)) {
      return errorTo(socket, "その部屋コードはすでに使われています。別のコードを指定してください。");
    }

    if (![2, 3, 4].includes(count)) {
      return errorTo(socket, "対戦人数は2〜4人で指定してください。");
    }

    if (
      !Number.isInteger(size) ||
      size < 6 || size > 20 ||
      size % 2 !== 0
    ) {
      return errorTo(socket, "盤面サイズは6〜20の偶数で指定してください。");
    }

    const host = {
      clientId: cid,
      name: cleanName(name),
      colorId: 1,
      socketId: socket.id
    };

    const room = {
      code: normalizedCode,
      hostClientId: cid,
      playerCount: count,
      boardSize: size,
      players: [host],
      board: [],
      turn: 1,
      history: [],
      status: "lobby",
      message: "参加者を待っています。",
      chat: []
    };

    initializeBoard(room);
    room.status = "lobby";
    room.message = "参加者を待っています。";

    rooms.set(normalizedCode, room);
    attachSocket(room, host, socket);

    addChat(room, `${host.name}が部屋を作成しました。`, null, true);
    emitRoom(room);
  });

  // 部屋参加・再接続
  socket.on("join-room", ({ clientId, name, code } = {}) => {
    if (getRoomForSocket(socket)) leaveCurrent(socket);

    const normalizedCode = normalizeCode(code);
    const room = rooms.get(normalizedCode);

    if (!room) {
      return errorTo(socket, "部屋が見つかりません。コードを確認してください。");
    }

    const cid = String(clientId || "").slice(0, 80);

    if (!cid) {
      return errorTo(socket, "端末識別情報を取得できません。ページを再読み込みしてください。");
    }

    let player = room.players.find(p => p.clientId === cid);

    if (player) {
      attachSocket(room, player, socket);
      room.message = `${player.name}が再接続しました。`;
      addChat(room, `${player.name}が再接続しました。`, null, true);
      emitRoom(room);
      return;
    }

    if (room.status !== "lobby") {
      return errorTo(socket, "この対局は開始済みです。新しい部屋を作成してください。");
    }

    if (room.players.length >= room.playerCount) {
      return errorTo(socket, "この部屋は満員です。");
    }

    const used = new Set(room.players.map(p => p.colorId));
    const colorId = activePlayers(room).find(p => !used.has(p.id)).id;

    player = {
      clientId: cid,
      name: cleanName(name),
      colorId,
      socketId: socket.id
    };

    room.players.push(player);
    attachSocket(room, player, socket);

    room.message = `${player.name}（${COLORS[colorId - 1].name}）が参加しました。`;
    addChat(room, room.message, null, true);
    emitRoom(room);
  });

  socket.on("leave-room", () => leaveCurrent(socket));

  // 人数変更
  socket.on("set-player-count", ({ playerCount } = {}) => {
    const room = getRoomForSocket(socket);

    if (!room || !requireHost(socket, room)) return;
    if (room.status !== "lobby") {
      return errorTo(socket, "対局開始後は人数を変更できません。");
    }

    const n = Number(playerCount);

    if (![2, 3, 4].includes(n)) {
      return errorTo(socket, "2人、3人、または4人を選択してください。");
    }

    if (room.players.length > n) {
      return errorTo(socket, "参加者が多すぎます。先に参加者に退出してもらってください。");
    }

    room.playerCount = n;
    room.players.forEach((p, i) => {
      p.colorId = i + 1;
    });

    room.message = `対戦人数を${n}人に設定しました。`;
    emitRoom(room);
  });

  // 盤面サイズ変更
  socket.on("set-board-size", ({ boardSize } = {}) => {
    const room = getRoomForSocket(socket);

    if (!room || !requireHost(socket, room)) return;
    if (room.status !== "lobby") {
      return errorTo(socket, "対局開始後は盤面サイズを変更できません。");
    }

    const size = Number(boardSize);

    if (
      !Number.isInteger(size) ||
      size < 6 || size > 20 ||
      size % 2 !== 0
    ) {
      return errorTo(socket, "盤面サイズは6〜20の偶数で指定してください。");
    }

    room.boardSize = size;
    initializeBoard(room);
    room.status = "lobby";
    room.message = `盤面を${size}×${size}に設定しました。`;

    emitRoom(room);
  });

  // 対局開始
  socket.on("start-game", () => {
    const room = getRoomForSocket(socket);

    if (!room || !requireHost(socket, room)) return;
    if (room.status !== "lobby") {
      return errorTo(socket, "この対局はすでに開始されています。");
    }

    if (room.players.length !== room.playerCount) {
      return errorTo(socket, `開始するには${room.playerCount}人全員の参加が必要です。`);
    }

    initializeBoard(room);
    room.message = `対局開始！${playerById(room, 1)?.name || "黒"}（黒）の手番です。`;

    addChat(room, room.message, null, true);
    emitRoom(room);
  });

  // 石を置く
  socket.on("move", ({ x, y } = {}) => {
    const room = getRoomForSocket(socket);
    const player = room && playerForSocket(room, socket);

    if (!room || !player) {
      return errorTo(socket, "部屋に参加していません。");
    }

    if (room.status !== "playing") {
      return errorTo(socket, "対局中ではありません。");
    }

    if (player.colorId !== room.turn) {
      return errorTo(socket, "あなたの手番ではありません。");
    }

    x = Number(x);
    y = Number(y);

    if (
      !Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || x >= room.boardSize ||
      y < 0 || y >= room.boardSize
    ) return;

    const flips = getFlips(room.board, x, y, room.turn);

    if (!flips.length) {
      return errorTo(socket, "そこには置けません。薄い緑の点があるマスを選んでください。");
    }

    saveHistory(room);

    const played = room.turn;
    room.board[y][x] = played;

    for (const [fx, fy] of flips) {
      room.board[fy][fx] = played;
    }

    const next = nextPlayer(room, played);

    if (next === null) {
      finishGame(room);
    } else {
      const skipped = [];
      let id = (played % room.playerCount) + 1;

      while (id !== next) {
        skipped.push(
          playerById(room, id)?.name || COLORS[id - 1].name
        );
        id = (id % room.playerCount) + 1;
      }

      room.turn = next;

      room.message = skipped.length
        ? `${skipped.join("・")}は置けないためパス。${playerById(room, next)?.name}の手番です。`
        : `${playerById(room, next)?.name}の手番です。`;
    }

    emitRoom(room);
  });

  // パス
  socket.on("pass", () => {
    const room = getRoomForSocket(socket);
    const player = room && playerForSocket(room, socket);

    if (!room || !player || room.status !== "playing") return;
    if (player.colorId !== room.turn) {
      return errorTo(socket, "あなたの手番ではありません。");
    }

    if (legalMoves(room, room.turn).length) {
      return errorTo(socket, "置ける場所があるためパスできません。");
    }

    saveHistory(room);

    const next = nextPlayer(room, room.turn);

    if (next === null) {
      finishGame(room);
    } else {
      room.turn = next;
      room.message = `${player.name}はパス。${playerById(room, next)?.name}の手番です。`;
    }

    emitRoom(room);
  });

  // 1手戻す（ホストのみ）
  socket.on("undo", () => {
    const room = getRoomForSocket(socket);

    if (!room || !requireHost(socket, room)) return;
    if (room.status === "lobby") {
      return errorTo(socket, "対局開始後に利用できます。");
    }

    if (!room.history.length) {
      return errorTo(socket, "戻せる手がありません。");
    }

    const previous = room.history.pop();

    room.board = previous.board.map(row => row.slice());
    room.turn = previous.turn;
    room.status = previous.status;
    room.message = `${playerById(room, room.turn)?.name || COLORS[room.turn - 1].name}の手番に戻しました。`;

    emitRoom(room);
  });

  // 新しいゲーム
  socket.on("new-game", () => {
    const room = getRoomForSocket(socket);

    if (!room || !requireHost(socket, room)) return;

    if (room.players.length !== room.playerCount) {
      return errorTo(socket, `新しいゲームを始めるには${room.playerCount}人全員の参加が必要です。`);
    }

    initializeBoard(room);
    room.message = "ホストが新しいゲームを開始しました。黒の手番です。";

    addChat(room, room.message, null, true);
    emitRoom(room);
  });

  // チャット
  socket.on("chat-message", ({ text } = {}) => {
    const room = getRoomForSocket(socket);
    const player = room && playerForSocket(room, socket);

    if (!room || !player) {
      return errorTo(socket, "チャットを送信するには部屋に参加してください。");
    }

    const message = cleanMessage(text);
    if (!message) return;

    addChat(room, message, player, false);
    emitRoom(room);
  });

  // 切断時
  socket.on("disconnect", () => {
    const room = getRoomForSocket(socket);
    socketRoom.delete(socket.id);

    if (!room) return;

    const player = playerForSocket(room, socket);

    if (player) {
      player.socketId = null;
      room.message = `${player.name}の接続が切れました。再接続を待っています。`;
      addChat(room, room.message, null, true);
    }

    emitRoom(room);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Online Othello server listening on port ${PORT}`);
});