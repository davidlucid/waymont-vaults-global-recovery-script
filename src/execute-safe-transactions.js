const assert = require("assert");
const ethers = require("ethers");
const bip39 = require("bip39");
const { BIP32Factory } = require("bip32");
const ecc = require("tiny-secp256k1");
const bip32 = BIP32Factory(ecc);

// Import ABIs
const SAFE_ABI = require("./abi/Safe.json");
const MULTI_SEND_ABI = require("./abi/MultiSend.json");

// Constant addresses, typehashes, etc.
const MULTI_SEND_ADDRESS = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526";
const DOMAIN_SEPARATOR_TYPEHASH = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218";
const SAFE_TX_TYPEHASH = "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8";
const HD_PATH = "m/44/60/0/0";

assert(process.argv.length >= 10, "Not enough arguments supplied--you should have 8 arguments if you are calling one function, 11 if you are calling two, 14 if you are calling three, and so on.");
assert(process.argv[2].length > 0, "The JSON-RPC provider URL you entered is not valid.");
assert(process.argv[3].length === 42 && process.argv[3].substring(0, 2) === "0x", "The wallet contract address you entered is not valid.");
assert(/^\d+$/.test(process.argv[4]), "The vault subkey index you entered is not valid.");
assert(process.argv[5].length === 66 && process.argv[5].substring(0, 2) === "0x", "The funded Ethereum account private key you supplied (for gas fees) is not valid.");
assert(process.argv[6].split(" ").length === 12, "The mnemonic seed phrase you entered is not valid (should be 12 words separated by spaces).");
for (var i = 7; i < process.argv.length; i += 3) assert(process.argv[i].length === 42 && process.argv[i].substring(0, 2) === "0x", "One or more function call target parameters is not valid.");
for (var i = 8; i < process.argv.length; i += 3) assert(process.argv[i].length >= 2 && process.argv[i].substring(0, 2) === "0x", "One or more function call data parameters is not valid.");
for (var i = 9; i < process.argv.length; i += 3) assert(/^\d+$/.test(process.argv[i]), "One or more function call value parameters is not valid.");

// Instantiate provider, EOA, and contracts
let myProvider = new ethers.JsonRpcProvider(process.argv[2]);
let myFundedAccountForGas = new ethers.Wallet(process.argv[5], myProvider);
let mySafeContract = new ethers.Contract(process.argv[3], SAFE_ABI, myFundedAccountForGas);

// Get HD node child signing key for Safe specified by user
const mySeed = bip39.mnemonicToSeedSync(process.argv[6]);
const myNode = bip32.fromSeed(mySeed);
const myChild = myNode.derivePath(HD_PATH + `/${process.argv[4]}`);
const myChildWallet = new ethers.Wallet("0x" + Buffer.from(myChild.privateKey).toString("hex"));
const myChildSigningKey = myChildWallet.signingKey;

// Run async code
(async function() {
    // Ensure Safe threshold == 1
    const safeOwners = await mySafeContract.getOwners();
    assert(await mySafeContract.getThreshold() == 1, "Expected Safe threshold to be 1 but threshold. Maybe this Safe has not yet been recovered?");

    // Ensure Safe has signer as an owner
    let userSignerFoundOnSafe = false;
    for (const owner of safeOwners) if (owner.toLowerCase() === myChildWallet.address.toLowerCase()) userSignerFoundOnSafe = true;
    assert(userSignerFoundOnSafe, "Signing key not found as a root-level signer on this Safe. Maybe this safe has not yet been recovered?");

    // Generate transactions to send
    let transactions = [];

    for (let i = 0; i < (process.argv.length - 7) / 3; i++) {
        transactions.push({
            to: process.argv[7 + (i * 3)],
            data: process.argv[8 + (i * 3)],
            value: process.argv[9 + (i * 3)]
        });
    }

    // Encode MultiSend.multiSend function data
    const multiSendInterface = new ethers.Interface(MULTI_SEND_ABI);

    let packedTransactions = "0x";
    for (const tx of transactions) packedTransactions += ethers.solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, tx.to, tx.value ?? 0, ethers.dataLength(tx.data), tx.data]).substring(2);

    let data = multiSendInterface.encodeFunctionData("multiSend", [packedTransactions]);

    // Prepare rest of params for Safe.execTransaction
    const to = MULTI_SEND_ADDRESS;
    const value = 0;
    const operation = 1;
    const safeTxGas = 0;
    const baseGas = 0;
    const gasPrice = 0;
    const gasToken = "0x0000000000000000000000000000000000000000";
    const refundReceiver = "0x0000000000000000000000000000000000000000";

    // Sign params for Safe.execTransaction
    const nonce = await mySafeContract.nonce();

    const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address', 'uint256', 'bytes32', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'uint256'],
        [SAFE_TX_TYPEHASH, to, value, ethers.keccak256(data), operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce]
    );

    const safeTxHash = ethers.keccak256(encodedData);
    const domainSeparator = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address"], [DOMAIN_SEPARATOR_TYPEHASH, (await myProvider.getNetwork()).chainId, mySafeContract.target]));

    const encodedTransactionData = ethers.solidityPacked(
        ['bytes1', 'bytes1', 'bytes32', 'bytes32'],
        ['0x19', '0x01', domainSeparator, safeTxHash],
    );

    const overlyingHash = ethers.keccak256(encodedTransactionData);
    const userSignatureUnserialized = myChildSigningKey.sign(overlyingHash);
    const userSignature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [userSignatureUnserialized.r, userSignatureUnserialized.s, userSignatureUnserialized.v]);

    // Dispatch TX
    console.log("Submitting Safe.execTransaction... (in execute-safe-transactions.js)");
    const tx = await mySafeContract.execTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, userSignature);
    console.log("Submitted Safe.execTransaction with transaction hash:", tx.hash);
    console.log("Waiting for confirmations...");
    await tx.wait();
    console.log("Transaction confirmed!", tx.hash);
})();
