# KoraScan Sidecar: Deployment Guide

Run the KoraSidecar as a background service to automatically reclaim protocol rent.

## 📦 Prerequisites
- Node.js 18+
- A Solana RPC (Helius recommended)
- `pm2` (Optional, for daemon management)

## 🛠️ Step-by-Step Setup

### 1. Configuration
Create a `.env` file in the `sidecar` directory:
```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPERATOR_KEYPAIR_PATH=./path/to/keypair.json
HELIUS_API_KEY=YOUR_KEY
LOCAL_DB_PATH=korascan_local.db
```

### 2. Manual Sweep
Run a one-time sweep to reclaim all historical rent:
```bash
npm run build
node dist/index.js sweep
```

### 3. Running as a Daemon (PM2)
To keep the sidecar running in the background and scanning for new opportunities every hour:

**Install PM2:**
```bash
npm install -g pm2
```

**Start the Service:**
```bash
pm2 start dist/index.js --name "kora-sidecar" -- start --claim
```

**Monitor Logs:**
```bash
pm2 logs kora-sidecar
```

## 🔒 Security Note
KoraSidecar is the **only** component that touches your private keys. It is designed to be run **locally** or on a private server you control. 

The Telegram Bot and Web Hub are read-only and communicate with the Sidecar via the shared (Cloud) database only to report stats, never keys.
