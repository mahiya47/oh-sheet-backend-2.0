// ==========================================================
// Oh Sheet! Monopoly — board definition. HOGWARTS EDITION.
//
// A smaller, faster board: 4 corners + 6 tiles on the top/bottom edges +
// 7 tiles on the left/right edges = 30 tiles. Every non-corner tile on a
// side is either a property (a Harry Potter character), a Hogwarts House
// (this board's version of a utility — one per side, 4 total), or a card
// tile (Chance on 2 sides, Community Chest on the other 2, plus a 3rd
// Community Chest sitting in the corner that used to be Platform 9¾). No
// railroads, no tax tiles — kept lean on purpose. Corners: PLATFORM 9¾
// (this is the start/GO square — it collects $200 same as any GO tile
// always has, just renamed), AZKABAN (jail / just visiting), a plain
// COMMUNITY CHEST corner, and the AUCTION HOUSE.
//
// This file is the single source of truth for the RULES side of the
// board. The frontend has its own display-only copy (geometry only —
// names, colours, prices all come from here). Every rent calculation
// and legality check happens on the server.
// ==========================================================

// type: "go" | "street" | "utility" | "chance" | "chest" | "jail"
//     | "auction"
//
// For streets: rent[0] is the bare-lot rent, rent[1..3] are upgrade
// levels 1-3 (3 is the max). build is an array of 3 costs — the price to
// go from level 0->1, 1->2, and 2->3, rising each time. "Houses" is
// still the internal field name for upgrade level (0-3) — the UI shows
// it as a rent upgrade, not a house.
const BOARD = [
  { i: 0, type: "go", name: "Platform 9¾" },

  { i: 1, type: "street", name: "Filch", group: "brown", price: 60, rent: [2, 10, 90, 250], build: [50, 100, 150] },
  { i: 2, type: "chance", name: "Chance" },
  { i: 3, type: "street", name: "Dobby", group: "brown", price: 60, rent: [4, 20, 180, 450], build: [50, 100, 150] },
  { i: 4, type: "street", name: "Neville Longbottom", group: "lightblue", price: 100, rent: [6, 30, 270, 550], build: [50, 100, 150] },
  { i: 5, type: "utility", name: "Gryffindor Tower", price: 150 },
  { i: 6, type: "street", name: "Luna Lovegood", group: "lightblue", price: 100, rent: [6, 30, 270, 550], build: [50, 100, 150] },
  { i: 7, type: "street", name: "Cho Chang", group: "lightblue", price: 120, rent: [8, 40, 300, 600], build: [50, 100, 150] },

  { i: 8, type: "jail", name: "Azkaban" },

  { i: 9, type: "street", name: "Fred Weasley", group: "pink", price: 140, rent: [10, 50, 450, 750], build: [100, 200, 300] },
  { i: 10, type: "street", name: "George Weasley", group: "pink", price: 160, rent: [12, 60, 500, 900], build: [100, 200, 300] },
  { i: 11, type: "street", name: "Cedric Diggory", group: "orange", price: 180, rent: [14, 70, 550, 950], build: [100, 200, 300] },
  { i: 12, type: "utility", name: "Hufflepuff Basement", price: 150 },
  { i: 13, type: "street", name: "Nymphadora Tonks", group: "orange", price: 180, rent: [14, 70, 550, 950], build: [100, 200, 300] },
  { i: 14, type: "street", name: "Hagrid", group: "orange", price: 200, rent: [16, 80, 600, 1000], build: [100, 200, 300] },

  { i: 15, type: "chest", name: "Community Chest" },

  { i: 16, type: "street", name: "Sirius Black", group: "red", price: 220, rent: [18, 90, 700, 1050], build: [150, 300, 450] },
  { i: 17, type: "chance", name: "Chance" },
  { i: 18, type: "street", name: "Severus Snape", group: "red", price: 240, rent: [20, 100, 750, 1100], build: [150, 300, 450] },
  { i: 19, type: "street", name: "Minerva McGonagall", group: "yellow", price: 260, rent: [22, 110, 800, 1150], build: [150, 300, 450] },
  { i: 20, type: "utility", name: "Ravenclaw Tower", price: 150 },
  { i: 21, type: "street", name: "Remus Lupin", group: "yellow", price: 260, rent: [22, 110, 800, 1150], build: [150, 300, 450] },
  { i: 22, type: "street", name: "Albus Dumbledore", group: "yellow", price: 280, rent: [24, 120, 850, 1200], build: [150, 300, 450] },

  { i: 23, type: "auction", name: "Diagon Alley Auction" },

  { i: 24, type: "street", name: "Bellatrix Lestrange", group: "green", price: 300, rent: [26, 130, 900, 1275], build: [200, 400, 600] },
  { i: 25, type: "street", name: "Lord Voldemort", group: "green", price: 320, rent: [28, 150, 1000, 1400], build: [200, 400, 600] },
  { i: 26, type: "street", name: "Ron Weasley", group: "navy", price: 350, rent: [35, 175, 1100, 1500], build: [200, 400, 600] },
  { i: 27, type: "utility", name: "Slytherin Dungeon", price: 150 },
  { i: 28, type: "street", name: "Hermione Granger", group: "navy", price: 380, rent: [38, 190, 1200, 1600], build: [200, 400, 600] },
  { i: 29, type: "street", name: "Harry Potter", group: "navy", price: 400, rent: [50, 200, 1400, 2000], build: [200, 400, 600] },
];

const BOARD_SIZE = BOARD.length; // 30
const GO_SALARY = 200;
const START_CASH = 1500;
const JAIL_INDEX = 8;
const JAIL_FINE = 50;
const MAX_HOUSES = 3; // 3 === max upgrade level

// Every tile index belonging to each colour group — precomputed once, used
// for monopoly checks and even-build rules.
const GROUPS = {};
for (const tile of BOARD) {
  if (tile.type === "street") {
    if (!GROUPS[tile.group]) GROUPS[tile.group] = [];
    GROUPS[tile.group].push(tile.i);
  }
}

// No railroads on this board — kept as an empty array (rather than
// removed) so anything that still imports RAIL_TILES/RAIL_RENT degrades
// to "no railroads exist" instead of crashing.
const RAIL_TILES = [];
const RAIL_RENT = [25, 50, 100, 200];
const UTILITY_TILES = BOARD.filter((t) => t.type === "utility").map((t) => t.i);
const BUYABLE = new Set(
  BOARD.filter((t) => t.type === "street" || t.type === "utility").map((t) => t.i)
);

// --- Card decks -------------------------------------------------------
// kind: "money" (delta), "moveTo" (index, collect GO if passed),
//       "moveBy" (delta), "jail", "getout", "nearestUtility",
//       "eachPlayer" (delta: + = collect from each, - = pay each),
//       "repairs" (perHouse/perHotel — per upgrade level / max level)
const CHANCE_CARDS = [
  { text: "You found a Portkey — advance to Platform 9¾ and collect $200.", kind: "moveTo", index: 0 },
  { text: "Gringotts pays interest on your vault — collect $150.", kind: "money", delta: 150 },
  { text: "Your broomstick needs repairs. Pay $100.", kind: "money", delta: -100 },
  { text: "Advance to Harry Potter.", kind: "moveTo", index: 29 },
  { text: "A Dementor is near — go directly to Azkaban.", kind: "jail" },
  { text: "Get Out of Azkaban Free — keep this card.", kind: "getout" },
  { text: "A house-elf apparates you to the nearest Hogwarts House.", kind: "nearestUtility" },
  { text: "Go back 3 spaces.", kind: "moveBy", delta: -3 },
  { text: "The whole school chips in — collect $50 from every player.", kind: "eachPlayer", delta: 50 },
  { text: "A repair charm is needed on your properties. Pay $25 per upgrade level, $100 if maxed out.", kind: "repairs", perHouse: 25, perHotel: 100 },
  { text: "Advance to Ron Weasley.", kind: "moveTo", index: 26 },
  { text: "Owl post delivery fee. Pay $75.", kind: "money", delta: -75 },
  { text: "You won the House Cup — collect $200.", kind: "money", delta: 200 },
];

const CHEST_CARDS = [
  { text: "Gringotts error in your favour — collect $200.", kind: "money", delta: 200 },
  { text: "Hospital wing fee. Pay $50.", kind: "money", delta: -50 },
  { text: "Get Out of Azkaban Free — keep this card.", kind: "getout" },
  { text: "Caught out of bed after hours — go directly to Azkaban.", kind: "jail" },
  { text: "You brewed a perfect potion — collect $100.", kind: "money", delta: 100 },
  { text: "Ministry tax refund — collect $20.", kind: "money", delta: 20 },
  { text: "It's your birthday — collect $20 from every player.", kind: "eachPlayer", delta: 20 },
  { text: "Advance to Platform 9¾ and collect $200.", kind: "moveTo", index: 0 },
  { text: "You inherited an old vault — collect $100.", kind: "money", delta: 100 },
  { text: "A repair charm is needed on your properties. Pay $40 per upgrade level, $115 if maxed out.", kind: "repairs", perHouse: 40, perHotel: 115 },
  { text: "You sold some old spellbooks — collect $75.", kind: "money", delta: 75 },
  { text: "Cauldron replacement fee. Pay $60.", kind: "money", delta: -60 },
];

module.exports = {
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
};
