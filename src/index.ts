import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Command } from 'commander';
import fs from 'fs';
import {
    initDb,
    batchUpsertAccounts,
    getOperatorStats,
    getDetailedAnalytics,
    getWhitelist,
    addToWhitelist,
    removeFromWhitelist
} from './lib/database';
import { IncrementalScanner } from './lib/incremental-scanner';
import { Reclaimer } from './lib/reclaimer';
import { Analyzer } from './lib/analyzer';

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const OPERATOR_KEYPAIR_PATH = process.env.OPERATOR_KEYPAIR_PATH || './operator-keypair.json';

const program = new Command();

function loadKeypair(path: string): Keypair {
    try {
        const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
        return Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch (e) {
        console.error(`❌ Failed to load keypair from ${path}. Ensure it exists or set OPERATOR_KEYPAIR_PATH.`);
        process.exit(1);
    }
}

async function getMergedWhitelist(): Promise<string[]> {
    const dbWhitelist = await getWhitelist();
    let fileWhitelist: string[] = [];
    try {
        if (fs.existsSync('whitelist.json')) {
            const data = JSON.parse(fs.readFileSync('whitelist.json', 'utf-8'));
            if (Array.isArray(data)) fileWhitelist = data;
        }
    } catch { }
    return Array.from(new Set([...dbWhitelist, ...fileWhitelist]));
}

program
    .name('korascan')
    .description('KoraScan Sidecar - Unified Solana Rent Reclaimer')
    .version('1.1.0');

program.command('init')
    .description('Initialize local database')
    .action(async () => {
        await initDb();
        console.log('✅ Local database initialized.');
    });

/**
 * 1. START (Automatic Mode)
 * Combines Webhook Listener + Periodic Polling
 */
program.command('start')
    .description('Start automatic discovery and claiming (Webhooks + Polling)')
    .option('--claim', 'Enable automatic rent reclamation', false)
    .option('-p, --port <number>', 'Webhook listener port', '3333')
    .option('-i, --interval <hours>', 'Polling interval in hours', process.env.MONITOR_INTERVAL_HOURS || '2')
    .action(async (options) => {
        await initDb();
        const connection = new Connection(RPC_URL, 'confirmed');
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);
        const intervalMs = parseFloat(options.interval) * 60 * 60 * 1000;

        console.log(`\n🚀 KoraScan AUTOMATIC MODE started!`);
        console.log(`👤 Operator: ${operator.publicKey.toBase58()}`);
        console.log(`💰 Auto-Claim: ${options.claim ? 'ENABLED (Proceed with caution)' : 'DISABLED (Discovery only)'}`);

        // --- 1. Start Webhook Server ---
        const express = require('express');
        const bodyParser = require('body-parser');
        const { handleHeliusWebhook } = require('./lib/webhook-handler');
        const app = express();
        app.use(bodyParser.json());
        app.post('/webhook', async (req: any, res: any) => {
            await handleHeliusWebhook(req, res, operator.publicKey.toBase58());
            // If claim is enabled, we could trigger a check here, 
            // but usually polling is safer for batching.
        });
        app.listen(options.port);
        console.log(`📡 Webhook Listener: http://localhost:${options.port}/webhook`);

        // --- 2. Start Polling Loop ---
        const runCycle = async () => {
            console.log(`\n[${new Date().toLocaleTimeString()}] Starting polling cycle...`);
            try {
                // Discover via history
                const scanner = new IncrementalScanner(connection, operator.publicKey);
                await scanner.scan();

                if (options.claim) {
                    const whitelist = await getMergedWhitelist();
                    const reclaimer = new Reclaimer(connection, operator, { whitelist });
                    await reclaimer.reclaimAllEligible();
                }
            } catch (e: any) {
                console.error(`❌ Cycle failed: ${e.message}`);
            }
            console.log(`😴 Sleeping for ${options.interval} hours...`);
        };

        await runCycle();
        setInterval(runCycle, intervalMs);
    });

/**
 * 2. SWEEP (One-time Mode)
 * Quick Discovery and Claim
 */
program.command('sweep')
    .description('Run a one-time discovery and reclamation pass')
    .option('--claim', 'Execute reclaims after discovery', false)
    .option('--history', 'Use exhaustive history scan', false)
    .action(async (options) => {
        await initDb();
        const connection = new Connection(RPC_URL, 'confirmed');
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);

        console.log(`\n🧹 Starting one-time SWEEP...`);

        const scanner = new IncrementalScanner(connection, operator.publicKey);
        const { stats } = await scanner.scan();
        console.log(`✅ Scan complete. Tracked: ${stats.totalAccounts}`);

        if (options.claim) {
            const whitelist = await getMergedWhitelist();
            const reclaimer = new Reclaimer(connection, operator, { whitelist });
            const result = await reclaimer.reclaimAllEligible();
            console.log(`💰 Reclaimed ${result.success} accounts, Total: ${result.sol.toFixed(4)} SOL`);
        } else {
            const stats = await getOperatorStats(operator.publicKey.toBase58());
            console.log(`💰 Reclaimable: ${stats.reclaimableAccounts} (~${(stats.reclaimableLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
            console.log(`💡 Run with --claim to recover this rent.`);
        }
    });

/**
 * 3. STATS (Analytics Mode)
 */
program.command('stats')
    .description('Show detailed analytics and metrics')
    .action(async () => {
        await initDb();
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);
        const stats: any = await getDetailedAnalytics(operator.publicKey.toBase58());

        console.log(`\n📊 KoraScan Operator Analytics`);
        console.log(`================================`);
        console.log(`👤 Operator: ${operator.publicKey.toBase58()}`);
        console.log(`📦 Total Accounts Sponsored: ${stats.total_accounts}`);
        console.log(`👥 Unique Users Helped:      ${stats.unique_users}`);
        console.log(`💎 Unique Tokens Managed:    ${stats.unique_mints}`);
        console.log(`💰 Total SOL Reclaimed:      ${(stats.total_reclaimed_lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

        if (stats.top_mints && stats.top_mints.length > 0) {
            console.log(`\n🔝 Top Sponsored Mints:`);
            stats.top_mints.forEach((m: any) => {
                console.log(` - ${m.mint.slice(0, 8)}... : ${m.count} accounts`);
            });
        }

    });

/**
 * 4. ACTIVITY (History Mode)
 */
program.command('activity')
    .description('Show recent reclamation activity')
    .option('-n, --number <count>', 'Number of entries to show', '20')
    .action(async (options) => {
        await initDb();
        const { getRecentActivity } = require('./lib/database');
        const limit = parseInt(options.number);

        const activity = await getRecentActivity(limit);

        console.log(`\n📜 Recent Activity Log`);
        console.log(`======================`);

        if (activity.length === 0) {
            console.log("No activity recorded yet.");
            return;
        }

        activity.forEach((row: any) => {
            const date = new Date(row.timestamp).toLocaleString();
            const rent = (row.rent_paid / 1e9).toFixed(5);
            console.log(`[${date}] 💰 Reclaimed ${rent} SOL from ${row.pubkey.slice(0, 8)}...`);
        });
    });

/**
 * 5. CONFIG (Management Mode)
 */
const config = program.command('config').description('Manage configuration and settings');

config.command('whitelist')
    .description('Manage address whitelist')
    .argument('<action>', 'add, remove, or list')
    .argument('[address]', 'Solana address')
    .argument('[note]', 'Optional note for the address')
    .action(async (action, address, note) => {
        await initDb();
        if (action === 'add') {
            if (!address) return console.error('❌ Address required');
            await addToWhitelist(address, note);
            console.log(`✅ Added ${address} to whitelist.`);
        } else if (action === 'remove') {
            if (!address) return console.error('❌ Address required');
            await removeFromWhitelist(address);
            console.log(`✅ Removed ${address} from whitelist.`);
        } else {
            const list = await getWhitelist();
            console.log(`📋 Whitelisted Addresses:`);
            list.forEach(a => console.log(` - ${a}`));
        }
    });

config.command('webhook')
    .description('Setup Helius webhooks')
    .argument('<url>', 'Your public webhook endpoint URL')
    .action(async (url) => {
        const { HeliusClient } = require('./lib/helius');
        const helius = new HeliusClient(process.env.HELIUS_API_KEY, RPC_URL);
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);

        console.log(`🛰️ Registering Helius Webhook...`);
        try {
            const result = await helius.createWebhook(url, [operator.publicKey.toBase58()]);
            console.log(`✅ Webhook Created! ID: ${result.webhookID}`);
        } catch (e: any) {
            console.error(`❌ Registration failed: ${e.message}`);
        }
    });

program.parse();
