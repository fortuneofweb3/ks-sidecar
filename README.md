# KoraScan Sidecar - Unified Rent Reclaimer

A local-first, privacy-conscious tool for Solana operators to discover and reclaim rent from sponsored accounts.

## Features

- ⚡ **Real-time Discovery**: Integrated Helius Webhook listener.
- 🔍 **Exhaustive Scanning**: Incremental transaction history crawler.
- 💰 **Automated Reclaiming**: Batch reclamation of empty token accounts.
- 📊 **Rich Analytics**: Track impact, unique users, and rent recovered.
- 🛡️ **Whitelist Protection**: Safeguard accounts from accidental closure.

## Quick Start

### 1. Setup
Run the setup script to install dependencies and initialize your database:
```bash
chmod +x setup.sh
./setup.sh
```

### 2. Configure
1.  **Environment**: Edit `.env` with your `HELIUS_API_KEY` and `RPC_URL`.
2.  **Keypair**: Place your operator JSON keypair at `./operator-keypair.json`.

### 3. Usage

#### **Autonomous Mode (Recommended)**
Start the real-time listener and periodic polling in a single process.
```bash
npm run dev -- start --claim
```

#### **Manual Sweep**
Perform a single pass of discovery and optionally reclaim.
```bash
# Discovery only
npm run dev -- sweep

# Discovery + Reclaim
npm run dev -- sweep --claim
```

#### **Analytics**
View your operator's performance and impact.
```bash
npm run dev -- stats
```

#### **Activity Log**
View recent reclamation history.
```bash
npm run dev -- activity
```

#### **Configuration**
Manage your whitelist or setup Helius webhooks.
```bash
# Register webhook with Helius
npm run dev -- config webhook <your_public_url>/webhook

# Manage Whitelist
npm run dev -- config whitelist add <address> "Internal Wallet"
```


## Configuration Reference (`.env`)

| Variable | Description | Default |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | Integration URL for reclaim notifications | `""` |
| `MONITOR_INTERVAL_HOURS` | Frequency of checks in autonomous mode | `2` |
| `RECLAIM_BATCH_SIZE` | Accounts per transaction (safe range: 10-20) | `15` |
| `PRIORITY_FEE_MICRO_LAMPORTS` | Fee paid for faster inclusion | `10000` |
| `DRY_RUN` | If `true`, simulates actions without sending TXs | `false` |

## Commands Overview

| Command | Description |
| --- | --- |
| `start` | Automatic mode (Webhooks + Polling) |
| `sweep` | Manual one-time discovery pass |
| `stats` | Detailed operator metrics |
| `config` | Management of webhooks and whitelist |
| `init` | Initialize/Reset local database |

---
**Build for privacy. Built for Solana.**
