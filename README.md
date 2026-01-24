# KoraScan Sidecar (CLI) 🚀

The **Sidecar** is the execution engine of KoraScan. It runs locally on your machine (or server), securely holds your private keys, and performs the actual rent reclamation transactions.

## ✨ Features

- **Hybrid Discovery**: Automatic fallback between Turbo Mode (Helius V2) and Standard Crawler.
- **Zero-Trust Signing**: Keys never leave this process.
- **Safety First**: Verifies `CloseAuthority` and `Zero Balance` before signing anything.
- **Local Database**: Uses SQLite to track history without external dependencies.

## 🛠️ Setup Guide (Start Here)

Follow these steps to get your Autoclaimer running in 5 minutes.

### 1. Install & Build
```bash
npm install
npm run build
```

### 2. Configure Environment
Create your `.env` file from the template.
```bash
cp .env.example .env
```
*Edit `.env` to set your `RPC_URL` (Helius/QuickNode is recommended).*

### 3. Setup Your Wallet
The bot needs a Solana wallet (keypair) to sign "Close Account" transactions. 
**Real Money Safety**: It only needs enough SOL for transaction fees (0.01 SOL is plenty). It does **NOT** need access to your main cold storage.

**Option A: Use an existing keypair file**
If you have a file like `id.json`, copy it here:
```bash
cp /path/to/your/id.json ./operator-keypair.json
```

**Option B: Generate a fresh keypair**
If you are starting fresh, generate a new key and **fund it with 0.01 SOL**.
```bash
# You can use solana CLI if installed:
solana-keygen new -o operator-keypair.json
```

*Note: `operator-keypair.json` is git-ignored for your safety. Do not commit it.*

### 4. Run Verification
Ensure everything is connected correctly.
```bash
node dist/index.js status
```
*Expected: "Total tracked: 0"*

---

## 🏃 Usage

### 🔍 Scan Network
Find accounts where you are the Close Authority.
```bash
# Detects reclaimable accounts and saves to local DB
node dist/index.js scan
```

### 💰 Reclaim Rent
Close the discovered accounts and refund the SOL to your wallet.
```bash
# Process the reclamation queue
node dist/index.js reclaim
```

### 🔄 The "One-Liner" (Sweep)
Run Scan + Reclaim in one go. Perfect for cron jobs.
```bash
node dist/index.js sweep
```

### 👁️ Monitoring Mode
Run continuously as a daemon process.
```bash
# Checks every 24 hours (configurable in .env)
node dist/index.js monitor
```

---

## ⚡ Performance Tuning

| Mode | Trigger | Speed | Reliability |
| :--- | :--- | :--- | :--- |
| **Turbo Mode** | `HELIUS_API_KEY` is set | **< 1s** | ⭐⭐⭐⭐⭐ |
| **Crawler Mode** | Default | **~10 mins** | ⭐⭐⭐⭐ |

*We typically recommend a Helius RPC key for best experience.*
