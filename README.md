# KoraScan Sidecar

The secure, local-first rent reclamation engine for Kora operators. Powered by **Universal Discovery** — supporting Helius, Triton, Quicknode, Alchemy, and any standard Solana RPC.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Commands](#commands)
- [Universal Discovery](#universal-discovery)
- [Environment Variables](#environment-variables)
- [Safety Features](#safety-features)
- [Multi-Wallet Support](#multi-wallet-support)
- [How Kora Works (Deep Dive)](./HOW_KORA_WORKS.md)

---

## Quick Start

### 1. Prerequisites
- Node.js v18+
- Solana keypair (your operator wallet)

### 2. Setup
```bash
./setup.sh
```

The setup script will install dependencies and help you configure your `.env` with your preferred RPC provider.

### 3. Basic Usage
```bash
# Initialize the database for your operator
npm run dev -- init

# Audit your history (safe, no transactions)
npm run dev -- sweep

# Discovery + Automatic Rent Recovery
npm run dev -- sweep --claim
```

---

## Universal Discovery

KoraScan works automatically with your favorite RPC provider. You only need **one** API key:

| Provider | Key Required | Benefits |
|:---|:---|:---|
| **Helius** | `HELIUS_API_KEY` | Fastest scans using specialized indexing APIs. |
| **Triton** | `TRITON_API_KEY` | High-performance infrastructure with robust metadata. |
| **Quicknode** | `QUICKNODE_API_KEY` | Global reliability and stable instruction parsing. |
| **Alchemy** | `ALCHEMY_API_KEY` | Enterprise-grade stability. |

**How it works**: If you use Triton or Quicknode, KoraScan intelligently switches to its **Robust Fallback** engine. It manually parses raw instruction data and token balance changes to identify sponsorship events with 100% accuracy, even without Helius-style indexing.

---

## Commands

### `start`
**Watch Mode.** Designed for 24/7 operation with periodic discovery and automated reclamation.

```bash
# Watch mode (audit only)
npm run dev -- start

# Watch mode + auto-reclaim
npm run dev -- start --claim
```

### `sweep`
**One-time Mode.** Fast discovery and optional reclaim. Perfect for manual maintenance.

```bash
# Audit only
npm run dev -- sweep

# Audit + Reclaim
npm run dev -- sweep --claim

# Process all wallets in operators.json
npm run dev -- sweep --claim --all
```

### `stats`
Generate a performance report card for your operator.
```bash
npm run dev -- stats
```

---

## Environment Variables

| Variable | Description |
|:---|:---|
| `HELIUS_API_KEY` | Fast Scan & Enhanced APIs (Recommended). |
| `TRITON_API_KEY` | Use Triton One RPC cluster. |
| `QUICKNODE_API_KEY` | Use Quicknode RPC cluster. |
| `ALCHEMY_API_KEY` | Use Alchemy RPC cluster. |
| `OPERATOR_KEYPAIR_PATH` | Path to your operator keypair (Default: `./operator-keypair.json`). |
| `RECLAIM_COOL_DOWN_DAYS` | Safety delay after account is empty (Default: `0`, Recommended: `7`). |
| `TREASURY_WALLET` | Auto-forward reclaimed SOL to this cold wallet address. |

---

## Safety Features

KoraScan is built with safety as the #1 priority:

1.  **Double-Tap Verification**: Before every reclaim, we verify on-chain that the balance is zero and you are still the Close Authority.
2.  **Circuit Breaker**: Auto-aborts batches that exceed a SOL threshold (Default: `1.0 SOL`).
3.  **Local-First**: Private keys never leave your machine.
4.  **Whitelists**: Add addresses you never want to touch via `npm run dev -- config whitelist add`.

---

## License

MIT

---

**Built for Kora Operators.** Recover your rent. Recirculate capital.
