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
// Turns a jailed player sits out before walking free on their own. There
// is no rolling your way out and no fine to buy your way out — the only
// early exits are the table voting you free, or a Get Out of Jail Free
// card.
const JAIL_TURNS = 4;
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
      jailTurns: -1, // -1 = not in jail, 0..JAIL_TURNS = turns served
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
    jailVote: null, // { seat, eligible: [seats], votes: { seat: "free"|"keep" } }
    trade: null, // { seat, offerIndex, targetSeat, targetIndex } — Diagon Alley property exchange
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

// Properties a seat could offer or be offered in a Diagon Alley trade —
// owned by them and with no upgrades built (the classic rule: you can't
// trade a property with houses/hotels on it).
function tradeableProps(game, seat) {
  const out = [];
  for (const [idxStr, st] of Object.entries(game.tiles)) {
    if (st.owner === seat && st.houses === 0) out.push(Number(idxStr));
  }
  return out.sort((a, b) => a - b);
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

// Who gets a vote on a given jailed seat: everyone still in the game,
// except the jailed player themself, anyone else currently in Jail (they
// don't get a say while they're in there too), and anyone disconnected
// right now (treated the same as a jailed player — skipped, not counted).
function jailVoteEligible(game, seat) {
  return activeSeats(game).filter(
    (s) => s !== seat && game.players[s].jailTurns < 0 && game.players[s].connected,
  );
}

function goToJail(game, seat) {
  const eligible = jailVoteEligible(game, seat);
  if (eligible.length === 0) {
    // Nobody left outside Jail to vote on it — e.g. everyone else at the
    // table is already in there. Nothing to decide, so they just carry on
    // instead of sitting in an unvotable Jail forever.
    say(game, `Seat ${seat + 1} would be sent to Jail, but no one is free to vote — they carry on.`);
    return;
  }
  const p = game.players[seat];
  p.pos = JAIL_INDEX;
  p.jailTurns = 0;
  game.doubles = 0;
  say(game, `Seat ${seat + 1} was sent to Jail.`);
  game.jailVote = { seat, eligible, votes: {} };
}

// Voters who disconnect mid-vote are skipped rather than counted as a
// pending vote — same treatment as a voter who's in Jail themselves.
function jailVoteStillWaitingOn(game) {
  const jv = game.jailVote;
  if (!jv) return [];
  return jv.eligible.filter((s) => game.players[s].connected && jv.votes[s] === undefined);
}

// Majority of votes cast wins; a tie (or nobody voting at all) leaves the
// player in Jail as normal. Called once every still-connected eligible
// voter has voted, and as a safety net right before the jailed player's
// own turn comes up again, so a slow voter can never stall the table.
function resolveJailVote(game) {
  const jv = game.jailVote;
  if (!jv) return;
  const choices = Object.values(jv.votes);
  const freeCount = choices.filter((c) => c === "free").length;
  const keepCount = choices.filter((c) => c === "keep").length;
  if (freeCount > keepCount) {
    game.players[jv.seat].jailTurns = -1;
    say(game, `The table voted to free Seat ${jv.seat + 1} from Jail early.`);
  } else if (choices.length) {
    say(game, `The table voted for Seat ${jv.seat + 1} to stay in Jail (a tie stays in Jail).`);
  }
  game.jailVote = null;
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
  // `seat` says whose card this is — only they can dismiss it, and
  // everyone else's view is labelled with their name instead of reading
  // like it happened to them too.
  game.card = { deck, text: card.text, seat };
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
  if (tile.type === "jail") {
    // Landing on Azkaban puts you IN it (and starts the table's vote) —
    // this board has no separate "Go To Jail" square, so without this
    // the only ways in would be a card or three doubles, and the jail
    // vote would almost never come up.
    goToJail(game, seat);
    return;
  }
  if (tile.type === "chance" || tile.type === "chest") {
    if (depth >= 2) return; // don't chain card draws forever
    drawCard(game, seat, tile.type === "chance" ? "chance" : "chest", depth);
    return;
  }
  if (tile.type === "auction") {
    // Diagon Alley — offer a property exchange, but only if there's
    // actually something to trade: the landing player owns at least one
    // untouched (no-upgrade) property, and someone else does too. If not,
    // nothing happens and the turn just continues.
    const mine = tradeableProps(game, seat);
    const someoneElseHasOne = activeSeats(game).some(
      (s) => s !== seat && tradeableProps(game, s).length > 0,
    );
    if (mine.length > 0 && someoneElseHasOne) {
      game.phase = "trade_offer";
      game.pending = { type: "trade_offer" };
      say(game, `Seat ${seat + 1} landed on Diagon Alley — choosing a property to trade.`);
    }
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
  // purchase decision or Diagon Alley trade, otherwise the player is free
  // to manage/end.
  if (["debt", "buy", "over", "trade_offer", "trade_response"].includes(game.phase)) return;
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
  game.trade = null;
  game.doubles = 0;

  // Walk forward to the next player who can actually take a turn.
  // Someone still serving time in Jail doesn't get one: their turn is
  // served for them here and play moves straight on. They have no roll,
  // no actions and no End turn — the only ways out are the table's vote,
  // a Get Out of Jail Free card, or sitting out all JAIL_TURNS turns.
  let next = game.turn;
  for (let guard = 0; guard < game.players.length * (JAIL_TURNS + 2); guard++) {
    next = (next + 1) % game.players.length;
    if (game.players[next].bankrupt) continue;

    // Never let a jailed player's own turn come up before the table's
    // vote on them is settled — resolve it with whatever votes are in so
    // far, so a "free them" result lets them play this turn normally.
    if (game.jailVote && game.jailVote.seat === next) resolveJailVote(game);

    const p = game.players[next];
    if (p.jailTurns < 0) break; // not in Jail — this turn is theirs

    if (p.jailTurns >= JAIL_TURNS) {
      p.jailTurns = -1;
      say(game, `Seat ${next + 1} served their time and walked out of Jail.`);
      break; // out, and they play this turn
    }

    p.jailTurns += 1;
    const left = JAIL_TURNS - p.jailTurns;
    say(game, `Seat ${next + 1} sat out a turn in Jail — ${left} to go.`);
    // still inside: loop round to the next player
  }
  game.turn = next;
  game.phase = "roll";
}

// A player sent to Jail mid-turn has nothing left to do — no roll, no
// End turn button — so the server closes their turn for them. Held back
// while a drawn card is still on screen, so they get to read the card
// that put them there first (card_ack calls this again once it's gone).
function endJailedTurn(game, seat) {
  if (game.turn !== seat) return;
  if (game.players[seat].jailTurns < 0) return;
  if (game.phase !== "action") return;
  if (game.card) return;
  nextTurn(game);
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
  // waiting on `expectedPhase` (a single phase, a list of allowed phases,
  // or any phase when omitted).
  function actor(roomId, expectedPhase) {
    const room = myRoom(roomId);
    if (!room || room.status !== "playing") return null;
    const seat = seatOf(room, socket.userId);
    if (seat === -1 || seat !== room.game.turn) return null;
    if (room.game.phase === "over") return null;
    if (expectedPhase) {
      const phases = Array.isArray(expectedPhase) ? expectedPhase : [expectedPhase];
      if (!phases.includes(room.game.phase)) return null;
    }
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
    // Normally only valid at the start of your turn ("roll" phase). The
    // one exception: you rolled doubles and earned another roll, which
    // leaves you in "action" phase with game.doubles > 0 — let that one
    // extra case through so the doubles roll happens in a single click
    // instead of an "acknowledge, then roll" round trip.
    const found = actor(roomId, ["roll", "action"]);
    if (!found) return;
    const { room, seat, game } = found;
    if (game.phase === "action" && game.doubles <= 0) return;
    const p = game.players[seat];

    const d1 = crypto.randomInt(1, 7);
    const d2 = crypto.randomInt(1, 7);
    game.dice = [d1, d2];
    game.card = null;
    const isDouble = d1 === d2;
    const total = d1 + d2;

    // In Jail means no turn at all — nextTurn serves the time and skips
    // straight past them, so a roll should never arrive from someone in
    // there. Ignored rather than trusted, since the client is never the
    // authority on this.
    if (p.jailTurns >= 0) return;

    if (isDouble) {
      game.doubles += 1;
      if (game.doubles >= 3) {
        say(game, `Seat ${seat + 1} rolled three doubles in a row — off to Jail.`);
        goToJail(game, seat);
        game.phase = "action";
        endJailedTurn(game, seat);
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
    endJailedTurn(game, seat);
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
    // Settling was the last thing owed on a turn that ended in Jail —
    // close it out, since they get no End turn button in there.
    endJailedTurn(game, seat);
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

  // Playable at any point while you're inside, not just on your turn —
  // a jailed player doesn't get a turn to play it on any more.
  socket.on("mono:jail_card", ({ roomId }) => {
    const room = myRoom(roomId);
    if (!room || room.status !== "playing") return;
    const game = room.game;
    if (game.phase === "over") return;
    const seat = seatOf(room, socket.userId);
    if (seat === -1) return;
    const p = game.players[seat];
    if (p.bankrupt || p.jailTurns < 0 || p.getOut <= 0) return;
    p.getOut -= 1;
    p.jailTurns = -1;
    say(game, `Seat ${seat + 1} used a Get Out of Jail Free card.`);
    // Their release settles any vote that was running on them.
    if (game.jailVote && game.jailVote.seat === seat) game.jailVote = null;
    pushState(roomId);
  });

  // ---------------- Diagon Alley trade ----------------
  // Landing there put the game in "trade_offer" phase for whoever landed
  // (see resolveLanding). They pick one of their own untouched properties
  // plus one belonging to anyone else in a single call — the frontend
  // handles the two-step picker locally and only sends this once both are
  // chosen. Backing out beforehand is mono:trade_cancel instead.
  socket.on("mono:trade_propose", ({ roomId, offerIndex, targetIndex }) => {
    const found = actor(roomId, "trade_offer");
    if (!found) return;
    const { game, seat } = found;
    const offerSt = game.tiles[offerIndex];
    const targetSt = game.tiles[targetIndex];
    if (!offerSt || offerSt.owner !== seat || offerSt.houses !== 0) return;
    if (!targetSt || targetSt.owner === null || targetSt.owner === seat || targetSt.houses !== 0) return;
    if (game.players[targetSt.owner].bankrupt) return;

    game.trade = { seat, offerIndex, targetSeat: targetSt.owner, targetIndex };
    game.pending = null;
    game.phase = "trade_response";
    say(
      game,
      `Seat ${seat + 1} offered ${BOARD[offerIndex].name} for Seat ${targetSt.owner + 1}'s ${BOARD[targetIndex].name}.`,
    );
    pushState(roomId);
  });

  socket.on("mono:trade_cancel", ({ roomId }) => {
    const found = actor(roomId, "trade_offer");
    if (!found) return;
    const { game } = found;
    game.pending = null;
    game.phase = "action";
    pushState(roomId);
  });

  // Only the property's owner can answer — it doesn't need to be their
  // turn, same as a Jail vote. Everyone else just watches until they do.
  socket.on("mono:trade_respond", ({ roomId, choice }) => {
    const room = myRoom(roomId);
    if (!room || room.status !== "playing") return;
    const game = room.game;
    const trade = game.trade;
    if (!trade) return;
    if (choice !== "accept" && choice !== "deny") return;
    const seat = seatOf(room, socket.userId);
    if (seat === -1 || seat !== trade.targetSeat) return;

    if (choice === "accept") {
      const offerSt = game.tiles[trade.offerIndex];
      const targetSt = game.tiles[trade.targetIndex];
      // Re-check nothing shifted underneath since the offer was made
      // (a mortgage, a bankruptcy) before actually swapping anything.
      if (offerSt && targetSt && offerSt.owner === trade.seat && targetSt.owner === trade.targetSeat) {
        offerSt.owner = trade.targetSeat;
        targetSt.owner = trade.seat;
        game.players[trade.seat].cash += 100;
        game.players[trade.targetSeat].cash += 100;
        say(
          game,
          `Seat ${trade.seat + 1} and Seat ${trade.targetSeat + 1} swapped ${BOARD[trade.offerIndex].name} for ${BOARD[trade.targetIndex].name} — both collected $100.`,
        );
      }
    } else {
      say(game, `Seat ${trade.targetSeat + 1} turned down the trade.`);
    }
    game.trade = null;
    game.phase = "action";
    pushState(roomId);
  });

  // Only the player who drew the card can dismiss it — everyone else is
  // just watching, and the card stays up for them too until then.
  socket.on("mono:card_ack", ({ roomId }) => {
    const room = myRoom(roomId);
    if (!room || room.status !== "playing") return;
    const game = room.game;
    if (!game.card) return;
    const seat = seatOf(room, socket.userId);
    if (seat === -1 || seat !== game.card.seat) return;
    game.card = null;
    // If that card is what put them in Jail, this was the last thing left
    // on their turn — close it out for them (they get no End turn).
    endJailedTurn(game, seat);
    pushState(roomId);
  });

  // Any seated player can vote on a jailed table-mate — it doesn't need
  // to be your turn, and the jailed player themself isn't eligible.
  socket.on("mono:jail_vote", ({ roomId, choice }) => {
    const room = myRoom(roomId);
    if (!room || room.status !== "playing") return;
    const game = room.game;
    const jv = game.jailVote;
    if (!jv) return;
    if (choice !== "free" && choice !== "keep") return;
    const seat = seatOf(room, socket.userId);
    if (seat === -1 || !jv.eligible.includes(seat)) return;
    if (jv.votes[seat] !== undefined) return;
    jv.votes[seat] = choice;
    if (jailVoteStillWaitingOn(game).length === 0) resolveJailVote(game);
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
