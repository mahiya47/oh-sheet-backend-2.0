// ==========================================================
// Oh Sheet! Monopoly — board definition.
//
// Classic 40-tile layout (4 corners + 9 tiles per side) — the familiar
// Monopoly shape, just re-skinned: 22 buyable streets in 8 colour
// groups, themed by category (retro games / anime / blockbuster movies
// / video games) instead of city streets, plus 4 railroads, 2
// utilities, corners, taxes and card tiles. Prices and rents follow the
// original board's numbers exactly, since that curve is what keeps the
// game balanced.
//
// This file is the single source of truth for the RULES side of the
// board. The frontend has its own display-only copy (names, colours,
// prices) — every rent calculation and legality check happens here, on
// the server.
// ==========================================================

// type: "go" | "street" | "rail" | "utility" | "chance" | "chest"
//     | "tax" | "jail" | "parking" | "gotojail"
//
// For streets: rent[0] is the bare-lot rent, rent[1..4] are 1-4 houses,
// rent[5] is a hotel. build = cost per house/hotel on that group.
const BOARD = [
  { i: 0, type: "go", name: "GO" },

  { i: 1, type: "street", name: "Pac-Man", group: "brown", price: 60, rent: [2, 10, 30, 90, 160, 250], build: 50 },
  { i: 2, type: "chest", name: "Community Chest" },
  { i: 3, type: "street", name: "Tetris", group: "brown", price: 60, rent: [4, 20, 60, 180, 320, 450], build: 50 },
  { i: 4, type: "tax", name: "Income Tax", amount: 200 },
  { i: 5, type: "rail", name: "Millennium Falcon", price: 200 },
  { i: 6, type: "street", name: "Star Wars", group: "lightblue", price: 100, rent: [6, 30, 90, 270, 400, 550], build: 50 },
  { i: 7, type: "chance", name: "Chance" },
  { i: 8, type: "street", name: "Jurassic Park", group: "lightblue", price: 100, rent: [6, 30, 90, 270, 400, 550], build: 50 },
  { i: 9, type: "street", name: "Harry Potter", group: "lightblue", price: 120, rent: [8, 40, 100, 300, 450, 600], build: 50 },
  { i: 10, type: "jail", name: "Jail / Just Visiting" },

  { i: 11, type: "street", name: "Naruto", group: "pink", price: 140, rent: [10, 50, 150, 450, 625, 750], build: 100 },
  { i: 12, type: "utility", name: "Power Grid", price: 150 },
  { i: 13, type: "street", name: "One Piece", group: "pink", price: 140, rent: [10, 50, 150, 450, 625, 750], build: 100 },
  { i: 14, type: "street", name: "Attack on Titan", group: "pink", price: 160, rent: [12, 60, 180, 500, 700, 900], build: 100 },
  { i: 15, type: "rail", name: "Hogwarts Express", price: 200 },
  { i: 16, type: "street", name: "Minecraft", group: "orange", price: 180, rent: [14, 70, 200, 550, 750, 950], build: 100 },
  { i: 17, type: "chest", name: "Community Chest" },
  { i: 18, type: "street", name: "Grand Theft Auto V", group: "orange", price: 180, rent: [14, 70, 200, 550, 750, 950], build: 100 },
  { i: 19, type: "street", name: "Fortnite", group: "orange", price: 200, rent: [16, 80, 220, 600, 800, 1000], build: 100 },

  { i: 20, type: "parking", name: "Free Parking" },

  { i: 21, type: "street", name: "The Matrix", group: "red", price: 220, rent: [18, 90, 250, 700, 875, 1050], build: 150 },
  { i: 22, type: "chance", name: "Chance" },
  { i: 23, type: "street", name: "Inception", group: "red", price: 220, rent: [18, 90, 250, 700, 875, 1050], build: 150 },
  { i: 24, type: "street", name: "The Dark Knight", group: "red", price: 240, rent: [20, 100, 300, 750, 925, 1100], build: 150 },
  { i: 25, type: "rail", name: "Batmobile Garage", price: 200 },
  { i: 26, type: "street", name: "Dragon Ball", group: "yellow", price: 260, rent: [22, 110, 330, 800, 975, 1150], build: 150 },
  { i: 27, type: "street", name: "Demon Slayer", group: "yellow", price: 260, rent: [22, 110, 330, 800, 975, 1150], build: 150 },
  { i: 28, type: "utility", name: "Water Works", price: 150 },
  { i: 29, type: "street", name: "My Hero Academia", group: "yellow", price: 280, rent: [24, 120, 360, 850, 1025, 1200], build: 150 },

  { i: 30, type: "gotojail", name: "Go To Jail" },

  { i: 31, type: "street", name: "The Legend of Zelda", group: "green", price: 300, rent: [26, 130, 390, 900, 1100, 1275], build: 200 },
  { i: 32, type: "street", name: "God of War", group: "green", price: 300, rent: [26, 130, 390, 900, 1100, 1275], build: 200 },
  { i: 33, type: "chest", name: "Community Chest" },
  { i: 34, type: "street", name: "Elden Ring", group: "green", price: 320, rent: [28, 150, 450, 1000, 1200, 1400], build: 200 },
  { i: 35, type: "rail", name: "Nautilus", price: 200 },
  { i: 36, type: "chance", name: "Chance" },
  { i: 37, type: "street", name: "Avatar", group: "navy", price: 350, rent: [35, 175, 500, 1100, 1300, 1500], build: 200 },
  { i: 38, type: "tax", name: "Luxury Tax", amount: 100 },
  { i: 39, type: "street", name: "Avengers: Endgame", group: "navy", price: 400, rent: [50, 200, 600, 1400, 1700, 2000], build: 200 },
];

const BOARD_SIZE = BOARD.length; // 40
const GO_SALARY = 200;
const START_CASH = 1500;
const JAIL_INDEX = 10;
const JAIL_FINE = 50;
const MAX_HOUSES = 5; // 5 === hotel
const RAIL_RENT = [25, 50, 100, 200];

// Every tile index belonging to each colour group — precomputed once, used
// for monopoly checks and even-build rules.
const GROUPS = {};
for (const tile of BOARD) {
  if (tile.type === "street") {
    if (!GROUPS[tile.group]) GROUPS[tile.group] = [];
    GROUPS[tile.group].push(tile.i);
  }
}

const RAIL_TILES = BOARD.filter((t) => t.type === "rail").map((t) => t.i);
const UTILITY_TILES = BOARD.filter((t) => t.type === "utility").map((t) => t.i);
const BUYABLE = new Set(
  BOARD.filter((t) => t.type === "street" || t.type === "rail" || t.type === "utility").map((t) => t.i)
);

// --- Card decks -------------------------------------------------------
// kind: "money" (delta), "moveTo" (index, collect GO if passed),
//       "moveBy" (delta), "jail", "getout", "nearestRail", "nearestUtility",
//       "eachPlayer" (delta: + = collect from each, - = pay each),
//       "repairs" (perHouse/perHotel)
const CHANCE_CARDS = [
  { text: "Your post went viral — advance to GO and collect $200.", kind: "moveTo", index: 0 },
  { text: "Sponsored deal! Collect $150.", kind: "money", delta: 150 },
  { text: "Server bill due. Pay $100.", kind: "money", delta: -100 },
  { text: "Take a ride to the nearest railroad and pay double rent.", kind: "nearestRail" },
  { text: "Power surge — advance to the nearest utility.", kind: "nearestUtility" },
  { text: "Caught spamming the feed. Go directly to Jail.", kind: "jail" },
  { text: "Get Out of Jail Free — keep this card.", kind: "getout" },
  { text: "Advance to Avengers: Endgame.", kind: "moveTo", index: 39 },
  { text: "Go back 3 spaces.", kind: "moveBy", delta: -3 },
  { text: "Crowdfunding success — collect $50 from every player.", kind: "eachPlayer", delta: 50 },
  { text: "You broke production. Pay $25 per house and $100 per hotel.", kind: "repairs", perHouse: 25, perHotel: 100 },
  { text: "Advance to Minecraft.", kind: "moveTo", index: 16 },
  { text: "Domain renewal. Pay $75.", kind: "money", delta: -75 },
  { text: "Ad revenue payout — collect $200.", kind: "money", delta: 200 },
  { text: "Advance to The Legend of Zelda.", kind: "moveTo", index: 31 },
  { text: "Refactor gone wrong. Pay $120.", kind: "money", delta: -120 },
];

const CHEST_CARDS = [
  { text: "Bank error in your favour — collect $200.", kind: "money", delta: 200 },
  { text: "Doctor's fee. Pay $50.", kind: "money", delta: -50 },
  { text: "Get Out of Jail Free — keep this card.", kind: "getout" },
  { text: "Go directly to Jail.", kind: "jail" },
  { text: "Followers milestone — collect $100.", kind: "money", delta: 100 },
  { text: "Income tax refund — collect $20.", kind: "money", delta: 20 },
  { text: "It's your birthday — collect $20 from every player.", kind: "eachPlayer", delta: 20 },
  { text: "Advance to GO and collect $200.", kind: "moveTo", index: 0 },
  { text: "Hosting upgrade. Pay $100.", kind: "money", delta: -100 },
  { text: "Sold some old gear — collect $75.", kind: "money", delta: 75 },
  { text: "Street repairs. Pay $40 per house and $115 per hotel.", kind: "repairs", perHouse: 40, perHotel: 115 },
  { text: "Won second prize in a meme contest — collect $10.", kind: "money", delta: 10 },
  { text: "Consultancy fee — collect $130.", kind: "money", delta: 130 },
  { text: "Data breach settlement. Pay $150.", kind: "money", delta: -150 },
  { text: "Inheritance — collect $100.", kind: "money", delta: 100 },
  { text: "Cloud credits expired. Pay $60.", kind: "money", delta: -60 },
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
