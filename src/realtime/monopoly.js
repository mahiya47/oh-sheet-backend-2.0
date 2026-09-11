const crypto = require("crypto");
const {
  BOARD,
  BOARD_SIZE,
  GROUPS,
  RAIL_TILES,
  UTILITY_TILES,
  BUYABLE,
  RAIL_RENT,
  CHANCE_CARDS,
  CHEST_CARDS,
  GO_SALARY,
  START_CASH,
  JAIL_INDEX,
  JAIL_FINE,
  MAX_HOUSES,
} = require("./monopolyBoard");

// ==========================================================
// Oh Sheet! Monopoly — server-authoritative game engine.
//
// Unlike the 1v1 arcade games (which are challenge-a-friend), Monopoly
// runs on a LOBBY: one player creates a room, shares a 5-character code,
// and up to 8 players join before the host starts. Rooms live in the same
// in-memory `rooms` Map as the other games (gameSlug "monopoly"), with an
// extra `status: "lobby"` phase before "playing".
//
// Every rule — rent, build legality, whose turn it is — is decided here.
// Clients only ever *propose* actions; they never compute outcomes. After
// any change the whole game object is broadcast as `mono:state`, which is
// a few KB and keeps 8 clients trivially in sync without a pile of
// granular diff events.
// ==========================================================

// Up to 4 players — one seat per corner of the board/screen, matching
// the HUD layout (top-left, top-right, bottom-left, bottom-right). Games
// can start with as few as 2; the corners just show whoever's seated.
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const LOG_LIMIT = 40;
// A disconnected player isn't dropped straight away — a game shouldn't
// die because someone's phone slept. They keep their seat and their turn
// is auto-passed until they come back or the room empties.
// Seat order matches the 4 HUD corners: top-left, top-right, bottom-left,
// bottom-right.
const TOKEN_COLORS = ["#2f6fed", "#e5484d", "#43a047", "#f5c945"]; // blue, red, green, yellow

function shuffled(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function roomCode() {
  // No 0/O/1/I — these get read aloud and typed by hand.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function initGame(playerCount) {
  return {
    players: Array.from({ length: playerCount }, (_, seat) => ({
      seat,
      color: TOKEN_COLORS[seat],
      cash: START_CASH,
      pos: 0,
      jailTurns: -1, // -1 = not in jail, 0..2 = turns served
      getOut: 0, // Get Out of Jail Free cards held
      bankrupt: false,
      connected: true,
    })),
    // index -> { owner, houses, mortgaged }
    tiles: {},
    turn: 0,
    phase: "roll", // roll | buy | action | debt | over
    dice: null,
    doubles: 0,
    pending: null, // { type: "buy", index } | { type: "debt", amount, creditor }
    card: null, // last drawn card, for the card popup
    log: [],
    winner: null,
    started: Date.now(),
  };
}

function say(game, text) {
  game.log.push({ text, ts: Date.now() });
  if (game.log.length > LOG_LIMIT) game.log.splice(0, game.log.length - LOG_LIMIT);
}

function tileState(game, index) {
  if (!game.tiles[index]) game.tiles[index] = { owner: null, houses: 0, mortgaged: false };
  return game.tiles[index];
}

function ownerOf(game, index) {
  return game.tiles[index]?.owner ?? null;
}

function ownsGroup(game, seat, group) {
  return GROUPS[group].every((i) => ownerOf(game, i) === seat);
}

function activeSeats(game) {
  return game.players.filter((p) => !p.bankrupt).map((p) => p.seat);
}

// --- Money -----------------------------------------------------------

function rentFor(game, index, diceTotal) {
  const tile = BOARD[index];
  const st = game.tiles[index];
  if (!st || st.owner === null || st.mortgaged) return 0;

  if (tile.type === "street") {
    if (st.houses > 0) return tile.rent[st.houses];
    return ownsGroup(game, st.owner, tile.group) ? tile.rent[0] * 2 : tile.rent[0];
  }
  if (tile.type === "rail") {
    const owned = RAIL_TILES.filter((i) => ownerOf(game, i) === st.owner).length;
    return RAIL_RENT[owned - 1] || 0;
  }
  if (tile.type === "utility") {
    const owned = UTILITY_TILES.filter((i) => ownerOf(game, i) === st.owner).length;
    return diceTotal * (owned >= UTILITY_TILES.length ? 10 : 4);
  }
  return 0;
}

// What a player could raise if they liquidated everything — used to tell
// them (and the UI) whether a debt is survivable at all.
function liquidValue(game, seat) {
  let total = game.players[seat].cash;
  for (const [idxStr, st] of Object.entries(game.tiles)) {
    if (st.owner !== seat) continue;
    const tile = BOARD[Number(idxStr)];
    for (let lvl = 0; lvl < st.houses; lvl++) total += Math.floor((tile.build[lvl] || 0) / 2);
    if (!st.mortgaged) total += Math.floor(tile.price / 2);
  }
  return total;
}

// Charge `amount` to `seat`. If they can't cover it from cash, the game
// drops into the "debt" phase — they must mortgage/sell (or go bankrupt)
// before anything else happens. Returns true when paid outright.
function charge(game, seat, amount, creditor = null) {
  const player = game.players[seat];
  if (amount <= 0) return true;
  if (player.cash >= amount) {
    player.cash -= amount;
    if (creditor !== null) game.players[creditor].cash += amount;
    return true;
  }
  game.phase = "debt";
  game.pending = { type: "debt", amount, creditor };
  return false;
}

function pay(game, seat, amount) {
  game.players[seat].cash += amount;
}

// --- Movement & landing ----------------------------------------------

function goToJail(game, seat) {
  const p = game.players[seat];
  p.pos = JAIL_INDEX;
  p.jailTurns = 0;
  game.doubles = 0;
  say(game, `Seat ${seat + 1} was sent to Jail.`);
}

function moveTo(game, seat, index, { collectGo = true } = {}) {
  const p = game.players[seat];
  const passedGo = index < p.pos && collectGo;
  p.pos = index;
  if (passedGo) {
    pay(game, seat, GO_SALARY);
    say(game, `Seat ${seat + 1} passed GO and collected $${GO_SALARY}.`);
  }
}

function drawCard(game, seat, deck, depth = 0) {
  const cards = deck === "chance" ? CHANCE_CARDS : CHEST_CARDS;
  const key = deck === "chance" ? "chanceOrder" : "chestOrder";
  const posKey = deck === "chance" ? "chancePos" : "chestPos";
  if (!game[key] || game[posKey] >= game[key].length) {
    game[key] = shuffled(cards.length);
    game[posKey] = 0;
  }
  const card = cards[game[key][game[posKey]++]];
  game.card = { deck, text: card.text };
  say(game, `Seat ${seat + 1} drew: ${card.text}`);

  const p = game.players[seat];
  switch (card.kind) {
    case "money":
      if (card.delta >= 0) pay(game, seat, card.delta);
      else charge(game, seat, -card.delta);
      break;
    case "moveTo":
      moveTo(game, seat, card.index);
      resolveLanding(game, seat, null, depth + 1);
      break;
    case "moveBy": {
      let next = (p.pos + card.delta + BOARD_SIZE) % BOARD_SIZE;
      p.pos = next; // going back never pays GO
      resolveLanding(game, seat, null, depth + 1);
      break;
    }
    case "jail":
      goToJail(game, seat);
      break;
    case "getout":
      p.getOut += 1;
      break;
    case "nearestRail":
    case "nearestUtility": {
      const targets = card.kind === "nearestRail" ? RAIL_TILES : UTILITY_TILES;
      let best = targets[0];
      for (let step = 1; step <= BOARD_SIZE; step++) {
        const idx = (p.pos + step) % BOARD_SIZE;
        if (targets.includes(idx)) { best = idx; break; }
      }
      moveTo(game, seat, best);
      resolveLanding(game, seat, null, depth + 1, card.kind === "nearestRail" ? 2 : 1);
      break;
    }
    case "eachPlayer": {
      const others = activeSeats(game).filter((s) => s !== seat);
      if (card.delta >= 0) {
        for (const s of others) charge(game, s, card.delta, seat);
      } else {
        for (const s of others) pay(game, s, -card.delta);
        charge(game, seat, -card.delta * others.length);
      }
      break;
    }
    case "repairs": {
      let bill = 0;
      for (const [idxStr, st] of Object.entries(game.tiles)) {
        if (st.owner !== seat) continue;
        if (st.houses === MAX_HOUSES) bill += card.perHotel;
        else bill += st.houses * card.perHouse;
      }
      if (bill > 0) charge(game, seat, bill);
      break;
    }
    default:
      break;
  }
}

// Work out what happens on the tile a player just landed on.
// `rentMultiplier` supports the "pay double rent" chance cards.
function resolveLanding(game, seat, diceTotal, depth = 0, rentMultiplier = 1) {
  const p = game.players[seat];
  const index = p.pos;
  const tile = BOARD[index];
  const total = diceTotal ?? (game.dice ? game.dice[0] + game.dice[1] : crypto.randomInt(2, 13));

  if (tile.type === "gotojail") {
    goToJail(game, seat);
    return;
  }
  if (tile.type === "tax") {
    say(game, `Seat ${seat + 1} paid $${tile.amount} ${tile.name}.`);
    charge(game, seat, tile.amount);
    return;
  }
  if (tile.type === "chance" || tile.type === "chest") {
    if (depth >= 2) return; // don't chain card draws forever
    drawCard(game, seat, tile.type === "chance" ? "chance" : "chest", depth);
    return;
  }
  if (!BUYABLE.has(index)) return; // GO, jail visit, free parking

  const owner = ownerOf(game, index);
  if (owner === null) {
    // Unowned — offer it. (Auctions land in the next pass; declining
    // simply leaves it on the market for now.)
    game.phase = "buy";
    game.pending = { type: "buy", index };
    return;
  }
  if (owner === seat) return;
  if (game.players[owner].bankrupt) return;
  const st = game.tiles[index];
  if (st.mortgaged) {
    say(game, `${tile.name} is mortgaged — no rent due.`);
    return;
  }
  const rent = rentFor(game, index, total) * rentMultiplier;
  if (rent > 0) {
    say(game, `Seat ${seat + 1} paid $${rent} rent on ${tile.name}.`);
    charge(game, seat, rent, owner);
  }
}

// --- Turn flow --------------------------------------------------------

function settleAfterAction(game) {
  // Called after any resolution step: debt takes priority, then a pending
  // purchase decision, otherwise the player is free to manage/end.
  if (game.phase === "debt" || game.phase === "buy" || game.phase === "over") return;
  game.phase = "action";
}

function nextTurn(game) {
  const alive = activeSeats(game);
  if (alive.length <= 1) {
    game.phase = "over";
    game.winner = alive[0] ?? null;
    if (game.winner !== null) say(game, `Seat ${game.winner + 1} wins the game!`);
    return;
  }
  game.dice = null;
  game.card = null;
  game.pending = null;
  game.doubles = 0;

  let next = game.turn;
  for (let guard = 0; guard < BOARD_SIZE; guard++) {
    next = (next + 1) % game.players.length;
    if (!game.players[next].bankrupt) break;
  }
  game.turn = next;
  game.phase = "roll";
}

function bankrupt(game, seat, creditor) {
  const p = game.players[seat];
  p.bankrupt = true;
  p.cash = 0;

  for (const [idxStr, st] of Object.entries(game.tiles)) {
    if (st.owner !== seat) continue;
    const index = Number(idxStr);
    if (creditor !== null && creditor !== undefined && !game.players[creditor].bankrupt) {
      st.owner = creditor;
      // Houses are sold back to the bank at half price, paid to the
      // creditor — the classic rule, and it stops a hotel row transferring
      // wholesale on a single bad landing.
      if (st.houses > 0) {
        const buildCosts = BOARD[index].build;
        for (let lvl = 0; lvl < st.houses; lvl++) {
          game.players[creditor].cash += Math.floor((buildCosts[lvl] || 0) / 2);
        }
        st.houses = 0;
      }
    } else {
      st.owner = null;
      st.houses = 0;
      st.mortgaged = false;
    }
  }
  say(game, `Seat ${seat + 1} went bankrupt.`);
  game.pending = null;
  game.phase = "action";
}

// --- Build / mortgage rules ------------------------------------------

function canBuild(game, seat, index) {
  const tile = BOARD[index];
  const st = game.tiles[index];
  if (!tile || tile.type !== "street") return false;
  if (!st || st.owner !== seat || st.mortgaged) return false;
  if (st.houses >= MAX_HOUSES) return false;
  if (!ownsGroup(game, seat, tile.group)) return false;
  if (GROUPS[tile.group].some((i) => game.tiles[i]?.mortgaged)) return false;
  // Even-build: never more than one house ahead of the rest of the group.
  const min = Math.min(...GROUPS[tile.group].map((i) => game.tiles[i]?.houses || 0));
  if (st.houses > min) return false;
  return game.players[seat].cash >= tile.build[st.houses];
}

function canSellHouse(game, seat, index) {
  const tile = BOARD[index];
  const st = game.tiles[index];
  if (!tile || tile.type !== "street" || !st || st.owner !== seat || st.houses <= 0) return false;
  const max = Math.max(...GROUPS[tile.group].map((i) => game.tiles[i]?.houses || 0));
  return st.houses >= max; // sell down evenly
}

function canMortgage(game, seat, index) {
  const st = game.tiles[index];
  if (!st || st.owner !== seat || st.mortgaged) return false;
  const tile = BOARD[index];
  if (tile.type === "street" && GROUPS[tile.group].some((i) => (game.tiles[i]?.houses || 0) > 0)) {
    return false; // sell the group's houses first
  }
  return true;
}

function attachMonopoly(io, socket, ctx) {
  const { rooms, codes, roomChannel } = ctx;

  function seatOf(room, userId) {
    return room.players.findIndex((p) => p.userId === userId);
  }

  function sanitize(p) {
    return { userId: p.userId, username: p.username, name: p.name, avatarUrl: p.avatarUrl };
  }

  function pushLobby(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    io.to(roomChannel(roomId)).emit("mono:lobby", {
      roomId,
      code: room.code,
      hostUserId: room.hostUserId,
      players: room.players.map(sanitize),
      max: MAX_PLAYERS,
    });
  }

  // The board never changes, so it rides along only on the first push a
  // client gets (game start, or reconnecting) and is cached client-side —
  // that keeps the board definition in one place, here on the server,
  // without re-sending 48 tiles on every dice roll.
  function pushState(roomId, { withBoard = false, to = null } = {}) {
    const room = rooms.get(roomId);
    if (!room || !room.game) return;
    const payload = {
      roomId,
      game: room.game,
      players: room.players.map(sanitize),
    };
    if (withBoard) payload.board = BOARD;
    const target = to ? io.to(to) : io.to(roomChannel(roomId));
    target.emit("mono:state", payload);
  }

  function myRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameSlug !== "monopoly") return null;
    return room;
  }

  // The player whose turn it is, if that's this socket and the game is
  // waiting on `expectedPhase` (or any phase when omitted).
  function actor(roomId, expectedPhase) {
    const room = myRoom(roomId);
    if (!room || room.status !== "playing") return null;
    const seat = seatOf(room, socket.userId);
    if (seat === -1 || seat !== room.game.turn) return null;
    if (room.game.phase === "over") return null;
    if (expectedPhase && room.game.phase !== expectedPhase) return null;
    return { room, seat, game: room.game };
  }

  // ---------------- Lobby ----------------

  socket.on("mono:create", (_payload, ack) => {
    if (typeof ack !== "function") return;
    const roomId = crypto.randomBytes(4).toString("hex");
    let code = roomCode();
    let guard = 0;
    while (codes.has(code) && guard++ < 20) code = roomCode();

    const room = {
      gameSlug: "monopoly",
      status: "lobby",
      code,
      hostUserId: socket.userId,
      players: [{ ...socket.userInfo, socketId: socket.id }],
      game: null,
      timeout: null,
    };
    rooms.set(roomId, room);
    codes.set(code, roomId);
    socket.join(roomChannel(roomId));
    ack({ ok: true, roomId, code });
    pushLobby(roomId);
  });

  socket.on("mono:join", ({ code }, ack) => {
    if (typeof ack !== "function") return;
    const roomId = codes.get(String(code || "").trim().toUpperCase());
    const room = roomId ? myRoom(roomId) : null;
    if (!room) return ack({ ok: false, error: "not_found" });
    if (room.status !== "lobby") return ack({ ok: false, error: "already_started" });
    if (room.players.length >= MAX_PLAYERS) return ack({ ok: false, error: "full" });

    const existing = seatOf(room, socket.userId);
    if (existing !== -1) {
      room.players[existing].socketId = socket.id; // rejoined from another tab
    } else {
      room.players.push({ ...socket.userInfo, socketId: socket.id });
    }
    socket.join(roomChannel(roomId));
    ack({ ok: true, roomId, code: room.code });
    pushLobby(roomId);
  });

  socket.on("mono:resume", ({ roomId }, ack) => {
    // Re-attaching after a refresh or a dropped connection.
    const room = myRoom(roomId);
    if (!room) return typeof ack === "function" && ack({ ok: false, error: "not_found" });
    const seat = seatOf(room, socket.userId);
    if (seat === -1) return typeof ack === "function" && ack({ ok: false, error: "not_in_room" });
    room.players[seat].socketId = socket.id;
    socket.join(roomChannel(roomId));
    if (room.game) room.game.players[seat].connected = true;
    if (typeof ack === "function") ack({ ok: true, roomId, code: room.code, status: room.status });
    if (room.status === "lobby") pushLobby(roomId);
    else pushState(roomId, { withBoard: true, to: socket.id });
  });

  socket.on("mono:start", ({ roomId }) => {
    const room = myRoom(roomId);
    if (!room || room.status !== "lobby") return;
    if (room.hostUserId !== socket.userId) return;
    if (room.players.length < MIN_PLAYERS) return;

    room.status = "playing";
    room.game = initGame(room.players.length);
    say(room.game, "Game started. Seat 1 rolls first.");
    pushState(roomId, { withBoard: true });
  });

  // ---------------- Turn actions ----------------

  socket.on("mono:roll", ({ roomId }) => {
    const found = actor(roomId, "roll");
    if (!found) return;
    const { room, seat, game } = found;
    const p = game.players[seat];

    const d1 = crypto.randomInt(1, 7);
    const d2 = crypto.randomInt(1, 7);
    game.dice = [d1, d2];
    game.card = null;
    const isDouble = d1 === d2;
    const total = d1 + d2;

    if (p.jailTurns >= 0) {
      if (isDouble) {
        p.jailTurns = -1;
        say(game, `Seat ${seat + 1} rolled doubles and left Jail.`);
        moveTo(game, seat, (p.pos + total) % BOARD_SIZE);
        resolveLanding(game, seat, total);
      } else {
        p.jailTurns += 1;
        if (p.jailTurns >= 3) {
          say(game, `Seat ${seat + 1} served their time and paid the $${JAIL_FINE} fine.`);
          if (charge(game, seat, JAIL_FINE)) {
            p.jailTurns = -1;
            moveTo(game, seat, (p.pos + total) % BOARD_SIZE);
            resolveLanding(game, seat, total);
          }
        } else {
          say(game, `Seat ${seat + 1} stayed in Jail.`);
        }
      }
      settleAfterAction(game);
      pushState(roomId);
      return;
    }

    if (isDouble) {
      game.doubles += 1;
      if (game.doubles >= 3) {
        say(game, `Seat ${seat + 1} rolled three doubles in a row — off to Jail.`);
        goToJail(game, seat);
        game.phase = "action";
        pushState(roomId);
        return;
      }
    } else {
      game.doubles = 0;
    }

    say(game, `Seat ${seat + 1} rolled ${d1} + ${d2}.`);
    moveTo(game, seat, (p.pos + total) % BOARD_SIZE);
    resolveLanding(game, seat, total);
    settleAfterAction(game);
    pushState(roomId);
  });

  socket.on("mono:buy", ({ roomId }) => {
    const found = actor(roomId, "buy");
    if (!found) return;
    const { game, seat } = found;
    const index = game.pending?.index;
    if (index === undefined) return;
    const tile = BOARD[index];
    if (ownerOf(game, index) !== null) return;
    if (game.players[seat].cash < tile.price) return;

    game.players[seat].cash -= tile.price;
    tileState(game, index).owner = seat;
    say(game, `Seat ${seat + 1} bought ${tile.name} for $${tile.price}.`);
    game.pending = null;
    game.phase = "action";
    pushState(roomId);
  });

  socket.on("mono:decline_buy", ({ roomId }) => {
    const found = actor(roomId, "buy");
    if (!found) return;
    const { game } = found;
    const index = game.pending?.index;
    if (index !== undefined) say(game, `${BOARD[index].name} was left on the market.`);
    game.pending = null;
    game.phase = "action";
    pushState(roomId);
  });

  socket.on("mono:build", ({ roomId, index }) => {
    const found = actor(roomId);
    if (!found) return;
    const { game, seat } = found;
    if (!["action", "debt"].includes(game.phase)) return;
    if (!canBuild(game, seat, index)) return;
    const tile = BOARD[index];
    const st = tileState(game, index);
    game.players[seat].cash -= tile.build[st.houses];
    st.houses += 1;
    const newRent = tile.rent[st.houses];
    say(
      game,
      `Seat ${seat + 1} upgraded ${tile.name} to level ${st.houses}${st.houses === MAX_HOUSES ? " (max)" : ""} — rent is now $${newRent}.`
    );
    pushState(roomId);
  });

  socket.on("mono:sell_house", ({ roomId, index }) => {
    const found = actor(roomId);
    if (!found) return;
    const { game, seat } = found;
    if (!canSellHouse(game, seat, index)) return;
    const tile = BOARD[index];
    const st = tileState(game, index);
    st.houses -= 1;
    game.players[seat].cash += Math.floor(tile.build[st.houses] / 2);
    say(game, `Seat ${seat + 1} downgraded ${tile.name} to level ${st.houses} — rent is now $${tile.rent[st.houses]}.`);
    pushState(roomId);
  });

  socket.on("mono:mortgage", ({ roomId, index }) => {
    const found = actor(roomId);
    if (!found) return;
    const { game, seat } = found;
    if (!canMortgage(game, seat, index)) return;
    const tile = BOARD[index];
    tileState(game, index).mortgaged = true;
    game.players[seat].cash += Math.floor(tile.price / 2);
    say(game, `Seat ${seat + 1} mortgaged ${tile.name}.`);
    pushState(roomId);
  });

  socket.on("mono:unmortgage", ({ roomId, index }) => {
    const found = actor(roomId);
    if (!found) return;
    const { game, seat } = found;
    const st = game.tiles[index];
    if (!st || st.owner !== seat || !st.mortgaged) return;
    const cost = Math.ceil((BOARD[index].price / 2) * 1.1); // 10% interest
    if (game.players[seat].cash < cost) return;
    game.players[seat].cash -= cost;
    st.mortgaged = false;
    say(game, `Seat ${seat + 1} lifted the mortgage on ${BOARD[index].name}.`);
    pushState(roomId);
  });

  // Pay off whatever put the player into the "debt" phase, once they've
  // raised enough by mortgaging or selling buildings.
  socket.on("mono:settle", ({ roomId }) => {
    const found = actor(roomId, "debt");
    if (!found) return;
    const { game, seat } = found;
    const debt = game.pending;
    if (!debt || debt.type !== "debt") return;
    if (game.players[seat].cash < debt.amount) return;

    game.players[seat].cash -= debt.amount;
    if (debt.creditor !== null && debt.creditor !== undefined) {
      game.players[debt.creditor].cash += debt.amount;
    }
    say(game, `Seat ${seat + 1} settled a debt of $${debt.amount}.`);
    game.pending = null;
    game.phase = "action";
    pushState(roomId);
  });

  socket.on("mono:bankrupt", ({ roomId }) => {
    const found = actor(roomId, "debt");
    if (!found) return;
    const { game, seat } = found;
    const creditor = game.pending?.creditor ?? null;
    bankrupt(game, seat, creditor);
    nextTurn(game);
    pushState(roomId);
  });

  socket.on("mono:end_turn", ({ roomId }) => {
    const found = actor(roomId, "action");
    if (!found) return;
    const { game, seat } = found;
    const p = game.players[seat];
    // Rolling doubles buys another roll — unless it put you in Jail.
    if (game.doubles > 0 && p.jailTurns < 0) {
      game.phase = "roll";
      game.card = null;
      game.pending = null;
      say(game, `Seat ${seat + 1} rolled doubles — rolling again.`);
    } else {
      nextTurn(game);
    }
    pushState(roomId);
  });

  socket.on("mono:jail_pay", ({ roomId }) => {
    const found = actor(roomId, "roll");
    if (!found) return;
    const { game, seat } = found;
    const p = game.players[seat];
    if (p.jailTurns < 0) return;
    if (p.cash < JAIL_FINE) return;
    p.cash -= JAIL_FINE;
    p.jailTurns = -1;
    say(game, `Seat ${seat + 1} paid $${JAIL_FINE} to leave Jail.`);
    pushState(roomId);
  });

  socket.on("mono:jail_card", ({ roomId }) => {
    const found = actor(roomId, "roll");
    if (!found) return;
    const { game, seat } = found;
    const p = game.players[seat];
    if (p.jailTurns < 0 || p.getOut <= 0) return;
    p.getOut -= 1;
    p.jailTurns = -1;
    say(game, `Seat ${seat + 1} used a Get Out of Jail Free card.`);
    pushState(roomId);
  });

  // Skip a player who has dropped out mid-game so the table isn't stuck.
  socket.on("mono:force_skip", ({ roomId }) => {
    const room = myRoom(roomId);
    if (!room || room.status !== "playing") return;
    if (seatOf(room, socket.userId) === -1) return;
    const game = room.game;
    const current = game.players[game.turn];
    if (current.connected || game.phase === "over") return;
    say(game, `Seat ${game.turn + 1} was skipped (disconnected).`);
    nextTurn(game);
    pushState(roomId);
  });

  socket.on("mono:leave", ({ roomId }) => {
    const room = myRoom(roomId);
    if (!room) return;
    const seat = seatOf(room, socket.userId);
    if (seat === -1) return;

    if (room.status === "lobby") {
      room.players.splice(seat, 1);
      socket.leave(roomChannel(roomId));
      if (room.players.length === 0) {
        codes.delete(room.code);
        rooms.delete(roomId);
        return;
      }
      if (room.hostUserId === socket.userId) room.hostUserId = room.players[0].userId;
      pushLobby(roomId);
      return;
    }

    const game = room.game;
    if (game && !game.players[seat].bankrupt) {
      bankrupt(game, seat, null);
      if (game.turn === seat) nextTurn(game);
      else if (activeSeats(game).length <= 1) nextTurn(game);
    }
    socket.leave(roomChannel(roomId));
    pushState(roomId);
  });
}

// Called from gameSockets' disconnect handler instead of nuking the room:
// an 8-player game shouldn't end because one phone went to sleep.
function handleMonopolyDisconnect(io, socket, ctx, roomId, room) {
  const { rooms, codes, roomChannel } = ctx;
  const seat = room.players.findIndex((p) => p.socketId === socket.id);
  if (seat === -1) return;

  if (room.status === "lobby") {
    room.players.splice(seat, 1);
    if (room.players.length === 0) {
      codes.delete(room.code);
      rooms.delete(roomId);
      return;
    }
    if (room.hostUserId === socket.userId) room.hostUserId = room.players[0].userId;
    io.to(roomChannel(roomId)).emit("mono:lobby", {
      roomId,
      code: room.code,
      hostUserId: room.hostUserId,
      players: room.players.map((p) => ({
        userId: p.userId, username: p.username, name: p.name, avatarUrl: p.avatarUrl,
      })),
      max: MAX_PLAYERS,
    });
    return;
  }

  if (room.game) {
    room.game.players[seat].connected = false;
    room.game.log.push({ text: `Seat ${seat + 1} lost connection.`, ts: Date.now() });
    const anyoneLeft = room.game.players.some((p) => p.connected && !p.bankrupt);
    if (!anyoneLeft) {
      codes.delete(room.code);
      rooms.delete(roomId);
      return;
    }
    io.to(roomChannel(roomId)).emit("mono:state", {
      roomId,
      game: room.game,
      players: room.players.map((p) => ({
        userId: p.userId, username: p.username, name: p.name, avatarUrl: p.avatarUrl,
      })),
    });
  }
}

module.exports = {
  attachMonopoly,
  handleMonopolyDisconnect,
  MAX_PLAYERS,
  MIN_PLAYERS,
  // exported for tests / sanity checks
  initGame,
  rentFor,
  canBuild,
  liquidValue,
};
