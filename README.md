# Using FlashBots for Bundled Transactions

利用 Flashbots `eth_sendBundle` API 在 Sepolia 测试网上捆绑 OpenspaceNFT 的 `enablePresale()` 和 `presale()` 交易，并使用 `eth_callBundle` 模拟和 `flashbots_getBundleStats` 查询状态。

## 项目结构

```
flashbots-bundle/
├── deploy-and-bundle.js   # 主脚本：编译 + 部署 + Bundle
├── bundle-only.js         # 已有合约时仅 Bundle
├── OpenspaceNFT.sol       # 原始合约（含 OpenZeppelin 导入）
├── package.json
└── README.md
```

## 快速开始

```bash
# 安装依赖
npm install

# 方式一：一键部署+捆绑（推荐）
PRIVATE_KEY=0x你的私钥 node deploy-and-bundle.js

# 方式二：仅 Bundle（已有合约）
PRIVATE_KEY=0x你的私钥 CONTRACT_ADDR=0x合约地址 node bundle-only.js

# 可选参数
PRESALE_AMOUNT=5  # 购买数量，默认 2
RPC_URL=https://...  # Sepolia RPC，默认 publicnode
```

## Flashbots API 交互

### Relay 端点

| 网络 | URL |
|------|-----|
| Sepolia (测试网) | `https://relay-sepolia.flashbots.net` |
| Mainnet | `https://relay.flashbots.net` |

### API 方法

#### 1. eth_sendBundle — 发送捆绑交易

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_sendBundle",
  "params": [{
    "txs": ["0x02...", "0x02..."],
    "blockNumber": "0xa9af90",
    "maxTimestamp": 1782189492
  }]
}
```

**请求头**：`X-Flashbots-Signature: <address>:<signature>`

**签名方式**（与官方 `@flashbots/ethers-provider-bundle` 库一致）：
- 计算 `keccak256(JSON请求体)` 
- 使用 `signMessage()` 签名（EIP-191 personal_sign 格式）
- 地址和签名都保留 `0x` 前缀

```js
const hash = ethers.keccak256(ethers.toUtf8Bytes(requestBody));
const sig = await wallet.signMessage(hash);
const header = `${wallet.address}:${sig}`;
```

#### 2. eth_callBundle — 模拟 Bundle 执行

```json
{
  "method": "eth_callBundle",
  "params": [{
    "txs": ["0x02...", "0x02..."],
    "blockNumber": "0xa9af90",
    "stateBlockNumber": "0xa9af8f"
  }]
}
```

返回每笔交易的 gasUsed、revert 原因等信息，用于验证 Bundle 正确性。

#### 3. flashbots_getBundleStats — 查询 Bundle 状态

```json
{
  "method": "flashbots_getBundleStats",
  "params": [{
    "bundleHash": "0x...",
    "blockNumber": "0xa9af90"
  }]
}
```

> **注意**：Sepolia Relay 不开放此方法（返回 `-32601: rpc method is not whitelisted`），仅主网可用。

### Bundle Hash 计算

```
bundleHash = keccak256(txHash1 || txHash2 || ...)
```

## 提交到 Sepolia 网络的交易

### 合约信息

| 字段 | 值 |
|------|-----|
| 网络 | Sepolia (Chain ID: 11155111) |
| 合约地址 | `0xdc08f3Fcb8b6d5067D47980A041f29a07Bf6A842` |
| Owner | `0xC7a263b1205226158b7A5F8Aa8fDbAAe9c15A55d` |
| Buyer | `0x2dD3250F1d4fDE5DaB9d2a2fec65daAa0CDDccF7` |

### 链上确认的交易哈希

| 交易 | 哈希 | 区块 | Gas |
|------|------|------|-----|
| Deploy | `0xe8dc3939b175d86b514ff4adf6c93174d99828686c47197e7b43da93c7313626` | 11120514 | 1,372,150 |
| Transfer | `0x593c0abffbefc13f14fc17d9cde68ae2f1ab3bddc79516aa3bdc3292ab5cba5a` | 11120602 | 21,000 |
| **enablePresale** | `0xb98b44b94efa1cc754542721500d87f48d8b4f25231f44c9361107dfe4a5d8c2` | 11120608 | 23,630 |
| **presale (2 tokens)** | `0x58364fce29dd51eba53d66d93d12b24c9dc3fcb0c5b25346ff1b9b9878e68ad1` | 11120609 | 101,488 |

### 合约最终状态

```
nextTokenId:     3
isPresaleActive: true
Buyer NFT 余额:  2 (Token #1, #2)
```

## Flashbots eth_callBundle 模拟结果

```
Bundle Hash: 0xf131f9576cc22d4d8a813913af97af5d75e14f1448c3114359ed5362e216c07e
State Block: 11120602
Total Gas Used: 125,118

Tx1 (enablePresale by Owner):
  From: 0xC7a263...A55d
  Gas Used: 23,630
  Result: ✅ OK

Tx2 (presale 2 tokens by Buyer):
  From: 0x2dD325...ccF7
  Gas Used: 101,488
  Value: 0.02 ETH
  Result: ✅ OK
```

## flashbots_getBundleStats 返回信息

Sepolia Relay 不开放此方法：

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32601,
    "message": "rpc method is not whitelisted"
  },
  "id": 1
}
```

该接口仅在主网 Relay (`https://relay.flashbots.net`) 可用。

## 关键设计说明

### 为何需要两个钱包

合约 OpenspaceNFT 的 `presale()` 函数包含：

```solidity
require(msg.sender != owner(), "Disabled for owner");
```

因此 Owner 不能直接参与 presale。Bundle 需要：
- **Owner** 签名 `enablePresale()` 交易
- **Buyer**（独立钱包）签名 `presale()` 交易
- 两笔交易捆绑后发送到 Flashbots Relay，原子执行

### Bundle 未被 Builder 包含的原因

Sepolia 测试网上活跃的 Flashbots Builder 极少，Bundle 虽然被 Relay 接受，但可能不会被及时打包进区块。实际交易通过直接发送到公共 mempool 完成确认。

## 参考资料

- [Flashbots 官方文档](https://docs.flashbots.net)
- [Flashbots 官网](https://www.flashbots.net)
- [eth_sendBundle API 指南](https://docs.flashbots.net/flashbots-auction/searchers/advanced/rpc-endpoint)
- [@flashbots/ethers-provider-bundle](https://www.npmjs.com/package/@flashbots/ethers-provider-bundle)
