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
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .action(async (options) => {
        await initDb();
        const connection = new Connection(RPC_URL, 'confirmed');
        const operator = loadKeypair(options.wallet);
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
                // Discover via history
                const scanner = new IncrementalScanner(connection, operator.publicKey);
                // Force verify on every cycle to ensure we catch external closes immediately
                await scanner.scan({ waitForSync: true, forceVerify: true });

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
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .action(async (options) => {
        await initDb();
        const connection = new Connection(RPC_URL, 'confirmed');
        const operator = loadKeypair(options.wallet);

        console.log(`\n🧹 Starting one-time SWEEP...`);

        const scanner = new IncrementalScanner(connection, operator.publicKey);
        const { stats } = await scanner.scan({ waitForSync: true, forceVerify: true });
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
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .action(async (options) => {
        await initDb();
        const operator = loadKeypair(options.wallet);
        const stats: any = await getDetailedAnalytics(operator.publicKey.toBase58());

        const totalReclaimed = stats.total_reclaimed_lamports / LAMPORTS_PER_SOL;
        const totalFees = stats.total_fees_lamports / LAMPORTS_PER_SOL;
        const netRecovery = totalReclaimed - totalFees;
        const totalAccounts = Number(stats.total_accounts);

        console.log(`\n📊 KoraScan Operator Analytics`);
        console.log(`================================`);
        console.log(`👤 Operator: ${operator.publicKey.toBase58()}`);
        console.log(`📦 Total Accounts Sponsored: ${totalAccounts.toLocaleString()}`);
        console.log(`   - 🟢 Active:   ${(stats.active_count || 0)}`);
        console.log(`   - 🔒 Locked:   ${(stats.locked_count || 0)}`);
        console.log(`   - 💀 Closed:   ${(stats.has_death_cert || 0)} (or external close)`);
        console.log(`👥 Unique Users Helped:      ${stats.unique_users.toLocaleString()}`);
        console.log(`\n💰 Financial Audit`);
        console.log(`--------------------------------`);
        console.log(`💵 Rent Reclaimed:           ${totalReclaimed.toFixed(4)} SOL`);
        console.log(`💸 Fees Paid:                ${totalFees.toFixed(4)} SOL`);
        console.log(`📈 Net Recovery:             ${netRecovery.toFixed(4)} SOL`);
        console.log(`\n🔍 Data Audit`);
        console.log(`--------------------------------`);
        console.log(`📅 Birth Certs (Timestamp):  ${stats.has_birth_cert.toLocaleString()} (${((stats.has_birth_cert / totalAccounts) * 100).toFixed(1)}%)`);
        console.log(`💀 Death Certs (Reclaimed):  ${stats.has_death_cert.toLocaleString()}`);

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
 * 5. EXPORT (Data Dump)
 */
program.command('export')
    .description('Export full audit log to CSV')
    .option('-o, --output <file>', 'Output filename', 'audit_export.csv')
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .action(async (options) => {
        await initDb();
        const { getAllAccounts } = require('./lib/database');
        const operator = loadKeypair(options.wallet);

        console.log(`\n📦 Exporting full audit log for ${operator.publicKey.toBase58()}...`);
        const accounts = await getAllAccounts(operator.publicKey.toBase58());

        if (accounts.length === 0) {
            console.log("⚠️ No accounts found to export.");
            return;
        }

        const keys = [
            'pubkey', 'userWallet', 'mint', 'status',
            'initialTimestamp', 'sponsorshipSource', 'memo', 'rentPaid',
            'reclaimedAt', 'reclaimSignature'
        ];

        const header = keys.join(',') + '\n';
        const rows = accounts.map((a: any) => {
            return keys.map(k => {
                let val = a[k];
                if (k === 'initialTimestamp' || k === 'reclaimedAt') {
                    if (!val) return '';
                    // Check if it's likely seconds (Helius) or ms (Date.now)
                    // Helius timestamps are usually 10 digits (seconds), Date.now is 13 (ms)
                    // If < 1e11 (which is year 1973 in ms), assume seconds and multiply
                    if (typeof val === 'number' && val < 100000000000) {
                        val = val * 1000;
                    }
                    return new Date(val).toISOString();
                }
                if (k === 'rentPaid') return (val / 1e9).toFixed(9);
                if (val === null || val === undefined) return '';
                return `"${String(val).replace(/"/g, '""')}"`; // CSV escape
            }).join(',');
        }).join('\n');

        fs.writeFileSync(options.output, header + rows);
        console.log(`✅ Exported ${accounts.length} records to ${options.output}`);
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
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .action(async (url, options) => {
        const { HeliusClient } = require('./lib/helius');
        const helius = new HeliusClient(process.env.HELIUS_API_KEY, RPC_URL);
        const operator = loadKeypair(options.wallet);

        console.log(`🛰️ Registering Helius Webhook...`);
        try {
            const result = await helius.createWebhook(url, [operator.publicKey.toBase58()]);
            console.log(`✅ Webhook Created! ID: ${result.webhookID}`);
        } catch (e: any) {
            console.error(`❌ Registration failed: ${e.message}`);
        }
    });

program.parse();
