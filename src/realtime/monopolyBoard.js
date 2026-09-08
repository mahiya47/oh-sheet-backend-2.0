// ==========================================================
// Oh Sheet! Monopoly — board definition.
//
// 48 tiles (vs the classic 40) with 34 buyable properties, sized for
// games of up to 8 players: 28 streets in 10 colour groups, 4 railroads,
// 2 utilities, plus corners, taxes and card tiles.
//
// Street/house prices follow the classic escalation curve so the game
// feels familiar, extended upward for the two extra colour groups.
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

  { i: 1, type: "street", name: "Dial-Up Drive", group: "brown", price: 60, rent: [2, 10, 30, 90, 160, 250], build: 50 },
  { i: 2, type: "chest", name: "Community Chest" },
  { i: 3, type: "street", name: "Pixel Place", group: "brown", price: 60, rent: [4, 20, 60, 180, 320, 450], build: 50 },
  { i: 4, type: "tax", name: "Income Tax", amount: 200 },
  { i: 5, type: "rail", name: "Fibre Line", price: 200 },
  { i: 6, type: "street", name: "Emoji Avenue", group: "lightblue", price: 100, rent: [6, 30, 90, 270, 400, 550], build: 50 },
  { i: 7, type: "chance", name: "Chance" },
  { i: 8, type: "street", name: "Meme Lane", group: "lightblue", price: 100, rent: [6, 30, 90, 270, 400, 550], build: 50 },
  { i: 9, type: "street", name: "Hashtag Heights", group: "lightblue", price: 120, rent: [8, 40, 100, 300, 450, 600], build: 50 },
  { i: 10, type: "utility", name: "Server Farm", price: 150 },
  { i: 11, type: "street", name: "Comment Court", group: "pink", price: 140, rent: [10, 50, 150, 450, 625, 750], build: 100 },

  { i: 12, type: "jail", name: "Jail / Just Visiting" },

  { i: 13, type: "street", name: "Notification Nook", group: "pink", price: 140, rent: [10, 50, 150, 450, 625, 750], build: 100 },
  { i: 14, type: "street", name: "Selfie Street", group: "pink", price: 160, rent: [12, 60, 180, 500, 700, 900], build: 100 },
  { i: 15, type: "rail", name: "5G Express", price: 200 },
  { i: 16, type: "street", name: "Podcast Parkway", group: "orange", price: 180, rent: [14, 70, 200, 550, 750, 950], build: 100 },
  { i: 17, type: "chest", name: "Community Chest" },
  { i: 18, type: "street", name: "Stream Station Road", group: "orange", price: 180, rent: [14, 70, 200, 550, 750, 950], build: 100 },
  { i: 19, type: "street", name: "Cache Crossing", group: "orange", price: 200, rent: [16, 80, 220, 600, 800, 1000], build: 100 },
  { i: 20, type: "chance", name: "Chance" },
  { i: 21, type: "street", name: "Firewall Freeway", group: "red", price: 220, rent: [18, 90, 250, 700, 875, 1050], build: 150 },
  { i: 22, type: "street", name: "Router Row", group: "red", price: 220, rent: [18, 90, 250, 700, 875, 1050], build: 150 },
  { i: 23, type: "street", name: "Bugfix Boulevard", group: "red", price: 240, rent: [20, 100, 300, 750, 925, 1100], build: 150 },

  { i: 24, type: "parking", name: "Free Parking" },

  { i: 25, type: "street", name: "Sunset Servers", group: "yellow", price: 260, rent: [22, 110, 330, 800, 975, 1150], build: 150 },
  { i: 26, type: "utility", name: "Power Grid", price: 150 },
  { i: 27, type: "street", name: "Golden Gigabyte", group: "yellow", price: 260, rent: [22, 110, 330, 800, 975, 1150], build: 150 },
  { i: 28, type: "street", name: "Bandwidth Bay", group: "yellow", price: 280, rent: [24, 120, 360, 850, 1025, 1200], build: 150 },
  { i: 29, type: "rail", name: "Satellite Link", price: 200 },
  { i: 30, type: "street", name: "Cloud Corner", group: "green", price: 300, rent: [26, 130, 390, 900, 1100, 1275], build: 200 },
  { i: 31, type: "chance", name: "Chance" },
  { i: 32, type: "street", name: "Startup Square", group: "green", price: 300, rent: [26, 130, 390, 900, 1100, 1275], build: 200 },
  { i: 33, type: "street", name: "Venture Villas", group: "green", price: 320, rent: [28, 150, 450, 1000, 1200, 1400], build: 200 },
  { i: 34, type: "chest", name: "Community Chest" },
  { i: 35, type: "tax", name: "Luxury Tax", amount: 150 },

  { i: 36, type: "gotojail", name: "Go To Jail" },

  { i: 37, type: "street", name: "Crypto Cove", group: "purple", price: 340, rent: [30, 160, 470, 1050, 1250, 1450], build: 200 },
  { i: 38, type: "street", name: "NFT Nook", group: "purple", price: 340, rent: [30, 160, 470, 1050, 1250, 1450], build: 200 },
  { i: 39, type: "street", name: "Metaverse Mews", group: "purple", price: 360, rent: [32, 170, 500, 1100, 1300, 1500], build: 200 },
  { i: 40, type: "rail", name: "Quantum Rail", price: 200 },
  { i: 41, type: "chest", name: "Community Chest" },
  { i: 42, type: "street", name: "AI Alley", group: "teal", price: 370, rent: [34, 180, 520, 1150, 1350, 1550], build: 250 },
  { i: 43, type: "street", name: "Neural Nexus", group: "teal", price: 370, rent: [34, 180, 520, 1150, 1350, 1550], build: 250 },
  { i: 44, type: "street", name: "Deep Learning Drive", group: "teal", price: 390, rent: [36, 190, 550, 1200, 1400, 1600], build: 250 },
  { i: 45, type: "chance", name: "Chance" },
  { i: 46, type: "street", name: "Unicorn Heights", group: "navy", price: 400, rent: [40, 200, 600, 1400, 1700, 2000], build: 250 },
  { i: 47, type: "street", name: "Oh Sheet! Tower", group: "navy", price: 450, rent: [50, 250, 700, 1600, 1900, 2200], build: 250 },
];

const BOARD_SIZE = BOARD.length; // 48
const GO_SALARY = 200;
const START_CASH = 1500;
const JAIL_INDEX = 12;
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
  { text: "Your post went viral — advance to GO.", kind: "moveTo", index: 0 },
  { text: "Sponsored deal! Collect $150.", kind: "money", delta: 150 },
  { text: "Server bill due. Pay $100.", kind: "money", delta: -100 },
  { text: "Take a ride to the nearest railroad and pay double rent.", kind: "nearestRail" },
  { text: "Power surge — advance to the nearest utility.", kind: "nearestUtility" },
  { text: "Caught spamming the feed. Go directly to Jail.", kind: "jail" },
  { text: "Get Out of Jail Free — keep this card.", kind: "getout" },
  { text: "Advance to Oh Sheet! Tower.", kind: "moveTo", index: 47 },
  { text: "Go back 3 spaces.", kind: "moveBy", delta: -3 },
  { text: "Crowdfunding success — collect $50 from every player.", kind: "eachPlayer", delta: 50 },
  { text: "You broke production. Pay $25 per house and $100 per hotel.", kind: "repairs", perHouse: 25, perHotel: 100 },
  { text: "Advance to Podcast Parkway.", kind: "moveTo", index: 16 },
  { text: "Domain renewal. Pay $75.", kind: "money", delta: -75 },
  { text: "Ad revenue payout — collect $200.", kind: "money", delta: 200 },
  { text: "Advance to Cloud Corner.", kind: "moveTo", index: 30 },
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
  { text: "Advance to GO.", kind: "moveTo", index: 0 },
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
