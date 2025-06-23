const assert = require("assert");
const ethers = require("ethers");

// Input validation
assert(process.argv.length == 3, "Invalid number of arguments supplied--you should have exactly 1 argument.");
assert(process.argv[2].split(" ").length === 12, "The mnemonic seed phrase you entered is not valid (should be 12 words separated by spaces).");

// Get HD node child signing key for Safe specified by user
const myNode = ethers.utils.HDNode.fromMnemonic(process.argv[2]);
console.log("Your xPub is:", myNode.neuter().extendedKey);
