# KoraScan CLI (Sidecar)

The engine behind KoraScan. A powerful, local-first tool for Kora operators to discover and reclaim rent from sponsored accounts.

## Features

- ⚡ **Automated Discovery**: Finds `SetAuthority` transactions where you sponsored the account.
- **Safety First**:
  - **Double-Tap Verification**: Verifies `balance == 0` on-chain immediately before signing.
  - **Cool-Down Period**: Optional 7-day wait for closed accounts.
  - **Circuit Breaker**: Auto-aborts if a single batch exceeds 1 SOL.
- **Privacy Focused**: Keys never leave your server. Simulation runs locally.
- 💼 **Multi-Wallet Support**: Manage multiple operator keypairs easily with the `--wallet` flag.
- 💰 **Automated Reclaiming**: Batch reclamation of empty token accounts.
- 📊 **Local Database**: All data is stored locally in SQLite for privacy and speed.
- 🛡️ **Safety Checks**: Built-in whitelist and strict validation to prevent accidental reclamation.

## Quick Start

### 1. Setup
Install dependencies:
```bash
npm install
```

### 2. Configure
Copy `.env.example` to `.env` and add your **HELIUS_API_KEY**:
```bash
cp .env.example .env
```

### 3. Usage

#### **Start Scanning & Reclaiming**
The primary command. Starts the discovery loop and (optionally) the reclaimer.

**Default (uses `./operator-keypair.json`):**
```bash
npm run dev -- start --claim
```

**Custom Wallet (Multi-Wallet):**
Specify a different keypair file to run the bot for another operator.
```bash
npm run dev -- start --wallet ./another-wallet.json --claim
```

**Discovery Only (No Reclaim):**
Just scans and updates the database without sending transactions.
```bash
npm run dev -- start --wallet ./my-wallet.json
```

#### **View Analytics**
Check the performance of your operator(s).
```bash
# Default wallet
npm run dev -- stats

# Specific wallet
npm run dev -- stats --wallet ./another-wallet.json
```

## How It Works

1.  **Discovery**: KoraScan queries Helius for your transaction history, specifically looking for `SET_AUTHORITY` transactions where you assigned a Close Authority to your operator. This is the definitive on-chain proof of a sponsored account.
2.  **Verification**: It checks if those accounts are now empty (0 balance) but still open.
3.  **Reclamation**: It sends batch transactions to close these accounts and return the rent SOL to your wallet.

## Configuration (`.env`)

| Variable | Description |
| --- | --- |
| `HELIUS_API_KEY` | **Required**. Your Helius API key for RPC and History API. |
| `RPC_URL` | Optional. Custom RPC URL (defaults to Helius). |
| `MONITOR_INTERVAL_HOURS` | `2` | Interval for `start` mode loop (hours) |
| `RECLAIM_COOL_DOWN_DAYS` | `7` | **Safety:** Days to wait after account closure before reclaiming. |
| `RECLAIM_CIRCUIT_BREAKER_SOL` | `1.0` | **Safety:** Max SOL allowed per batch. If exceeded, batch aborts. |
| `TREASURY_WALLET` | - | **Pro:** Auto-forward profits to this cold wallet. |
| `TREASURY_MIN_SOL` | `0.5` | **Pro:** Min hot wallet balance to keep before forwarding. |
| `DATABASE_URL` | Path to local SQLite DB (default: `file:korascan_local.db`). |
| `DRY_RUN` | If `true`, simulates actions without sending TXs. |

### Pro Tools

**Performance Report Card**
Generate a detailed efficiency report without leaving your terminal:
\`\`\`bash
npm run dev -- report
\`\`\`
Outputs a summary of efficiency, ROI, and top leak sources.

**Treasury Auto-Forwarding**
Protect your profits by automatically sweeping excess SOL to a cold wallet. Set `TREASURY_WALLET` in your `.env`.

---
**Built for Kora Operators.**
