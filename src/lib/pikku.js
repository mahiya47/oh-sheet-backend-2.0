// Pikku The Cat's entire personality: random cat noises. No API, no
// personality engine — just meows, ported as-is from the old backend.
function generateCatNoise() {
  const words = ["meow", "mew", "mewww", "mau"];

  // Pick a random length for the sentence (between 2 and 6 words)
  const length = Math.floor(Math.random() * 5) + 2;

  const noiseArray = [];
  for (let i = 0; i < length; i++) {
    const randomWord = words[Math.floor(Math.random() * words.length)];
    noiseArray.push(randomWord);
  }

  // Join them together, capitalize the first letter, and add punctuation
  let sentence = noiseArray.join(" ");
  sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);

  // 50/50 chance of ending with a period or exclamation mark
  const punctuation = Math.random() > 0.5 ? "!" : ".";

  return sentence + punctuation;
}

module.exports = { generateCatNoise };
