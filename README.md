# KoraScan Sidecar

The secure, local-first rent reclamation engine for Kora operators. Discover and reclaim SOL from sponsored token accounts without ever exposing your private keys.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Commands](#commands)
- [Environment Variables](#environment-variables)
- [Safety Features](#safety-features)
- [Multi-Wallet Support](#multi-wallet-support)
- [Pro Features](#pro-features)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

### Prerequisites
- Node.js v16+
- Git
- Solana keypair (your operator wallet)

### 1. Clone & Install

```bash
git clone https://github.com/fortuneofweb3/ks-sidecar.git
cd ks-sidecar
npm install
```

### 2. Configure

```bash
# Copy example config
cp .env.example .env

# Copy your operator keypair
cp ~/.config/solana/id.json ./operator-keypair.json
```

Edit `.env` and add your **Helius API key** (free at [helius.dev](https://helius.dev)):

```env
HELIUS_API_KEY=your_api_key_here
RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_api_key_here
```

### 3. Initialize & Run

```bash
# Initialize the database
npm run dev -- init

# Run discovery (audit only)
npm run dev -- sweep

# Run discovery + reclaim SOL
npm run dev -- sweep --claim
```

---

## Commands

### `init`
Initialize the local SQLite database for an operator.

```bash
npm run dev -- init
npm run dev -- init --wallet ./other-wallet.json
npm run dev -- init --all  # All wallets in operators.json
```

---

### `start`
**Automatic mode.** Runs continuously with webhook listener + periodic polling. Designed for 24/7 operation.

```bash
# Discovery only (watch mode)
npm run dev -- start

# Enable automatic reclamation
npm run dev -- start --claim

# Custom interval and port
npm run dev -- start --claim --interval 4 --port 3333
```

**Flags:**
| Flag | Default | Description |
|------|---------|-------------|
| `--claim` | `false` | Enable automatic rent reclamation |
| `-p, --port` | `3333` | Webhook listener port |
| `-i, --interval` | `2` | Polling interval in hours |
| `-w, --wallet` | `./operator-keypair.json` | Keypair file path |
| `-a, --all` | `false` | Run for all wallets in `operators.json` |

---

### `sweep`
**One-time mode.** Quick discovery and optional reclaim. Perfect for manual runs.

```bash
# Audit only
npm run dev -- sweep

# Audit + Reclaim
npm run dev -- sweep --claim

# All operators
npm run dev -- sweep --claim --all
```

**Flags:**
| Flag | Description |
|------|-------------|
| `--claim` | Execute reclaims after discovery |
| `--history` | Use exhaustive history scan |
| `-w, --wallet` | Specify keypair file |
| `-a, --all` | Process all wallets in `operators.json` |

---

### `stats`
Generate a performance report card.

```bash
npm run dev -- stats
npm run dev -- stats --wallet ./my-wallet.json
```

---

### `activity`
Show recent reclamation activity log.

```bash
npm run dev -- activity
npm run dev -- activity -n 50  # Last 50 entries
```

---

### `export`
Export full audit log to CSV for accounting/taxes.

```bash
npm run dev -- export
npm run dev -- export -o my_audit.csv
npm run dev -- export --all  # All operators
```

---

### `config whitelist`
Manage protected addresses that should never be reclaimed.

```bash
# Add to whitelist
npm run dev -- config whitelist add AAddressHere "My cold wallet" --wallet ./op.json

# Remove from whitelist
npm run dev -- config whitelist remove AAddressHere --wallet ./op.json

# List all whitelisted
npm run dev -- config whitelist list --wallet ./op.json
```

---

### `config webhook`
Setup Helius webhooks for real-time notifications.

```bash
npm run dev -- config webhook https://your-server.com/webhook
```

---

## Environment Variables

All configuration is done through the `.env` file.

### Core Settings (Required)

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint. **Use Helius for best performance.** |
| `HELIUS_API_KEY` | - | Helius API key for Enhanced Transactions. **Highly recommended.** |
| `OPERATOR_KEYPAIR_PATH` | `./operator-keypair.json` | Path to your operator keypair file. |

### Multi-Wallet Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `OPERATORS_CONFIG_PATH` | `./operators.json` | Path to JSON file with array of keypair paths. |

### Reclamation Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MONITOR_INTERVAL_HOURS` | `2` | How often to poll for new reclaimable accounts. |
| `PRIORITY_FEE_MICRO_LAMPORTS` | `10000` | Priority fee for transactions (in micro-lamports). |
| `RECLAIM_BATCH_SIZE` | `15` | Maximum accounts to reclaim per transaction batch. |

### Safety Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `RECLAIM_COOL_DOWN_DAYS` | `0` | Days to wait after account becomes empty before reclaiming. Set to `7` for extra safety. |
| `RECLAIM_CIRCUIT_BREAKER_SOL` | `0` | Maximum SOL allowed per batch. Batch aborts if exceeded. Set to `1.0` for protection. |

### Pro Features

| Variable | Default | Description |
|----------|---------|-------------|
| `TREASURY_WALLET` | - | Auto-forward reclaimed SOL to this cold wallet address. |
| `TREASURY_MIN_SOL` | `0.5` | Minimum SOL to keep in hot wallet before forwarding to treasury. |
| `DISCORD_WEBHOOK_URL` | - | Discord webhook URL for notifications. |

### Database Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `LOCAL_DB_PATH` | `korascan_local.db` | SQLite database filename. |
| `LOCAL_DB_DIR` | `.` | Directory for database files. |

### Advanced Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `HELIUS_API_URL` | `https://api.helius.xyz/v0` | Custom Helius API base URL. |

---

## Safety Features

KoraScan is built with safety as the #1 priority:

### 1. Double-Tap Verification
Before signing any transaction, we verify on-chain that:
- Account balance is exactly `0`
- You are still the Close Authority
- Transaction simulation succeeds

### 2. Cool-Down Period
Set `RECLAIM_COOL_DOWN_DAYS=7` to wait 7 days after an account becomes empty before reclaiming. Prevents accidental reclaims from accounts temporarily at zero.

### 3. Circuit Breaker
Set `RECLAIM_CIRCUIT_BREAKER_SOL=1.0` to automatically abort any batch that would reclaim more than 1 SOL. Protects against bugs or unexpected conditions.

### 4. Whitelist Protection
Add important addresses to the whitelist to prevent accidental reclamation:
```bash
npm run dev -- config whitelist add YourColdWallet "Never touch" --wallet ./op.json
```

### 5. Local Keys Only
Your private keys **never leave your machine**. All signing happens locally based on indexed data.

---

## Multi-Wallet Support

Manage multiple operator wallets from a single installation.

### 1. Create `operators.json`

```json
{
  "operators": [
    "./operator-keypair.json",
    "./staking-wallet.json",
    "./airdrop-wallet.json"
  ]
}
```

### 2. Use the `--all` flag

```bash
# Initialize all
npm run dev -- init --all

# Sweep all
npm run dev -- sweep --claim --all

# Start monitoring all
npm run dev -- start --claim --all

# Export all
npm run dev -- export --all
```

### 3. Or specify individual wallets

```bash
npm run dev -- sweep --claim --wallet ./staking-wallet.json
```

---

## Pro Features

### Treasury Auto-Forwarding

Automatically sweep reclaimed SOL to a cold wallet:

```env
TREASURY_WALLET=YourColdWalletAddress
TREASURY_MIN_SOL=0.5
```

The sidecar will keep `TREASURY_MIN_SOL` in the hot wallet for gas fees and forward the rest to your treasury.

### Discord Notifications

Get alerts in Discord:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### Helius Webhooks

For real-time monitoring instead of polling:

```bash
npm run dev -- config webhook https://your-server.com/webhook
```

---

## Troubleshooting

### "Too many accounts requested"
Your RPC is rate-limiting. **Solution:** Get a free Helius API key at [helius.dev](https://helius.dev).

### "Failed to load keypair"
The keypair file doesn't exist or is malformed. Make sure it's a JSON array of 64 numbers.

### "No reclaimable accounts found"
Either:
- You have no empty sponsored accounts yet
- All eligible accounts were already reclaimed
- Run `npm run dev -- stats` to see current state

### Slow scans
The first scan checks your entire history. Subsequent scans are incremental and much faster.

### Transaction failures
Try increasing the priority fee:
```env
PRIORITY_FEE_MICRO_LAMPORTS=50000
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    KoraScan Sidecar                     │
├─────────────────────────────────────────────────────────┤
│  Discoverer     │ Scans tx history for SetAuthority    │
│  Analyzer       │ Verifies accounts on-chain           │
│  Reclaimer      │ Builds & signs close transactions    │
│  Database       │ SQLite for local persistence         │
│  Webhook        │ Handles Helius real-time events      │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
              ┌───────────────────────┐
              │    Solana Network     │
              │  (via Helius RPC)     │
              └───────────────────────┘
```

---

## License

MIT

---

**Built for Kora Operators.** Recover your rent. Recirculate capital.
