/**
 * Flashbots Bundle Only — 对已部署的 OpenspaceNFT 发送捆绑交易
 *
 * 用法:
 *   PRIVATE_KEY=0x... CONTRACT_ADDR=0x... node bundle-only.js
 */

const ethers = require("ethers");
const https = require("https");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDR = process.env.CONTRACT_ADDR;
const SEPOLIA_RPC =
  process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const FLASHBOTS_RELAY = "https://relay-sepolia.flashbots.net";
const CHAIN_ID = 11155111;
const PRESALE_AMOUNT = parseInt(process.env.PRESALE_AMOUNT || "2");

const ABI = [
  "function enablePresale() external",
  "function presale(uint256 amount) external payable",
  "function isPresaleActive() external view returns (bool)",
  "function nextTokenId() external view returns (uint256)",
  "function owner() external view returns (address)",
];

async function signFlashbotsRequest(wallet, body) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(body));
  const sig = await wallet.signMessage(hash);
  return `${wallet.address}:${sig}`;
}

async function sendFlashbots(method, params, wallet) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const signature = await signFlashbotsRequest(wallet, body);
  return new Promise((resolve, reject) => {
    const url = new URL(FLASHBOTS_RELAY);
    const req = https.request(
      {
        hostname: url.hostname, port: 443, path: url.pathname || "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Flashbots-Signature": signature,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function computeBundleHash(signedTxs) {
  const hashes = signedTxs.map((tx) =>
    ethers.getBytes(ethers.Transaction.from(tx).hash)
  );
  return ethers.keccak256(ethers.concat(hashes));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!PRIVATE_KEY || !CONTRACT_ADDR) {
    console.error("用法: PRIVATE_KEY=0x... CONTRACT_ADDR=0x... node bundle-only.js");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("  Flashbots Bundle — OpenspaceNFT Presale");
  console.log("  合约:", CONTRACT_ADDR);
  console.log("  网络: Sepolia");
  console.log("=".repeat(60));

  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDR, ABI, wallet);

  const [balance, nonce, feeData, currentBlock, isActive, nextId] =
    await Promise.all([
      provider.getBalance(wallet.address),
      provider.getTransactionCount(wallet.address),
      provider.getFeeData(),
      provider.getBlockNumber(),
      contract.isPresaleActive(),
      contract.nextTokenId(),
    ]);

  console.log(`  地址: ${wallet.address}`);
  console.log(`  余额: ${ethers.formatEther(balance)} ETH`);
  console.log(`  Nonce: ${nonce}`);
  console.log(`  当前区块: ${currentBlock}`);
  console.log(`  isPresaleActive: ${isActive}`);
  console.log(`  nextTokenId: ${nextId.toString()}`);

  const targetBlock = currentBlock + 1;
  const maxFee = feeData.maxFeePerGas || ethers.parseUnits("50", "gwei");
  const maxPriority = feeData.maxPriorityFeePerGas || ethers.parseUnits("1.5", "gwei");
  const value = ethers.parseEther((PRESALE_AMOUNT * 0.01).toFixed(2));

  console.log(`\n  构建 Bundle (目标区块: ${targetBlock})...`);

  const tx1 = {
    to: CONTRACT_ADDR,
    data: contract.interface.encodeFunctionData("enablePresale"),
    chainId: CHAIN_ID, nonce, maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriority, gasLimit: 80000, type: 2, value: 0,
  };

  const tx2 = {
    to: CONTRACT_ADDR,
    data: contract.interface.encodeFunctionData("presale", [PRESALE_AMOUNT]),
    chainId: CHAIN_ID, nonce: nonce + 1, maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriority, gasLimit: 350000, type: 2, value,
  };

  const signedTx1 = await wallet.signTransaction(tx1);
  const signedTx2 = await wallet.signTransaction(tx2);

  const tx1Hash = ethers.Transaction.from(signedTx1).hash;
  const tx2Hash = ethers.Transaction.from(signedTx2).hash;
  const bundleHash = computeBundleHash([signedTx1, signedTx2]);

  console.log(`  Tx1 (enablePresale): ${tx1Hash}`);
  console.log(`  Tx2 (presale):       ${tx2Hash}`);
  console.log(`  Bundle Hash:         ${bundleHash}`);

  // eth_sendBundle
  console.log(`\n  发送 eth_sendBundle...`);
  const sendResult = await sendFlashbots("eth_sendBundle", [{
    txs: [signedTx1, signedTx2],
    blockNumber: ethers.toQuantity(targetBlock),
    maxTimestamp: Math.floor(Date.now() / 1000) + 180,
    revertingTxHashes: [],
  }], wallet);

  console.log("  eth_sendBundle 返回:");
  console.log(`  ${JSON.stringify(sendResult, null, 2).replace(/\n/g, "\n  ")}`);

  if (sendResult.error) {
    console.error(`  Bundle 发送失败: ${sendResult.error.message}`);
    process.exit(1);
  }

  // 等待并查询 stats
  console.log(`\n  等待 30 秒后查询 flashbots_getBundleStats...`);
  await sleep(30000);

  for (const bn of [targetBlock, targetBlock + 1]) {
    const stats = await sendFlashbots("flashbots_getBundleStats", [{
      bundleHash, blockNumber: ethers.toQuantity(bn),
    }], wallet);
    console.log(`\n  flashbots_getBundleStats (block ${bn}):`);
    console.log(`  ${JSON.stringify(stats, null, 2).replace(/\n/g, "\n  ")}`);
  }

  // 最终状态
  console.log("\n" + "=".repeat(60));
  console.log("  最终汇总");
  console.log("=".repeat(60));
  console.log(`  合约:             ${CONTRACT_ADDR}`);
  console.log(`  enablePresale Tx: ${tx1Hash}`);
  console.log(`  presale Tx:       ${tx2Hash}`);
  console.log(`  Bundle Hash:      ${bundleHash}`);
  console.log(`  目标区块:         ${targetBlock}`);
  console.log(`  购买数量:         ${PRESALE_AMOUNT} tokens`);
  console.log(`  支付金额:         ${ethers.formatEther(value)} ETH`);

  try {
    const [finalActive, finalNextId] = await Promise.all([
      contract.isPresaleActive(),
      contract.nextTokenId(),
    ]);
    console.log(`  isPresaleActive:  ${finalActive}`);
    console.log(`  nextTokenId:      ${finalNextId.toString()}`);
    if (finalNextId.toString() !== nextId.toString()) {
      console.log(`  ✅ 预售成功!`);
    }
  } catch (e) {
    console.log(`  查询失败: ${e.message}`);
  }
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
