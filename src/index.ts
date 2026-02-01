import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import {
    initDbForOperator,
    getOperatorStats,
    getDetailedAnalytics,
    getWhitelist,
    addToWhitelist,
    removeFromWhitelist
} from './lib/database';
import { Discoverer } from './lib/discoverer';
import { Reclaimer } from './lib/reclaimer';
import { getActiveRpcUrl } from './lib/rpc';

// Configuration
const RPC_URL = getActiveRpcUrl();
const OPERATOR_KEYPAIR_PATH = process.env.OPERATOR_KEYPAIR_PATH || './operator-keypair.json';
const OPERATORS_CONFIG_PATH = process.env.OPERATORS_CONFIG_PATH || './operators.json';

const program = new Command();

function loadKeypair(keypairPath: string): Keypair {
    try {
        // Resolve relative paths from sidecar directory
        const resolvedPath = path.isAbsolute(keypairPath)
            ? keypairPath
            : fs.existsSync(keypairPath)
                ? path.resolve(keypairPath)
                : path.resolve(__dirname, '..', keypairPath);
        const secretKey = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
        return Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch (e) {
        console.error(`❌ Failed to load keypair from ${keypairPath}. Ensure it exists.`);
        process.exit(1);
    }
}

/**
 * Load operator registry from operators.json
 */
function loadOperatorRegistry(): string[] {
    try {
        const configPath = path.isAbsolute(OPERATORS_CONFIG_PATH)
            ? OPERATORS_CONFIG_PATH
            : path.resolve(__dirname, '..', OPERATORS_CONFIG_PATH);
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return config.operators || [];
        }
    } catch (e) {
        console.error(`⚠️ Failed to load operators.json: ${e}`);
    }
    return [];
}

/**
 * Get operators based on --wallet or --all flag
 */
function getOperators(options: { wallet?: string; all?: boolean }): Keypair[] {
    if (options.all) {
        const paths = loadOperatorRegistry();
        if (paths.length === 0) {
            console.error('❌ No operators in operators.json. Add keypair paths to use --all.');
            process.exit(1);
        }
        return paths.map(p => loadKeypair(p));
    }
    return [loadKeypair(options.wallet || OPERATOR_KEYPAIR_PATH)];
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
    .description(
        'KoraScan Sidecar - Unified Solana Rent Reclaimer\n' +
        'For programmatic access, use: npm install korascan-sdk'
    )
    .version('1.1.0');

program.command('init')
    .description('Initialize local database for operator(s)')
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .option('-a, --all', 'Initialize DBs for all operators in operators.json', false)
    .action(async (options) => {
        const operators = getOperators(options);
        for (const operator of operators) {
            await initDbForOperator(operator.publicKey.toBase58());
            console.log(`✅ Database initialized for ${operator.publicKey.toBase58().slice(0, 8)}...`);
        }
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
    .option('-a, --all', 'Run for all operators in operators.json', false)
    .action(async (options) => {
        const connection = new Connection(RPC_URL, 'confirmed');
        const operators = getOperators(options);
        const operatorAddresses = new Set(operators.map(op => op.publicKey.toBase58()));

        // Initialize DB for all
        for (const op of operators) {
            await initDbForOperator(op.publicKey.toBase58());
        }

        const intervalMs = parseFloat(options.interval) * 60 * 60 * 1000;

        console.log(`\n🚀 KoraScan AUTOMATIC MODE started!`);
        console.log(`👥 Monitoring ${operators.length} operators:`);
        operators.forEach(op => console.log(`   - ${op.publicKey.toBase58()}`));
        console.log(`💰 Auto-Claim: ${options.claim ? 'ENABLED (Proceed with caution)' : 'DISABLED (Discovery only)'}`);

        // --- 1. Start Webhook Server ---
        const express = require('express');
        const bodyParser = require('body-parser');
        const { handleHeliusWebhook } = require('./lib/webhook-handler');
        const app = express();
        app.use(bodyParser.json());

        app.post('/webhook', async (req: any, res: any) => {
            await handleHeliusWebhook(req, res, operatorAddresses);
        });

        app.listen(options.port);
        console.log(`📡 Webhook Listener: http://localhost:${options.port}/webhook`);

        // --- 2. Start Polling Loop ---
        const runCycle = async () => {
            console.log(`\n[${new Date().toLocaleTimeString()}] Starting polling cycle...`);

            for (const operator of operators) {
                try {
                    // Discover via history
                    const scanner = new Discoverer(connection, operator.publicKey);
                    await scanner.scan({ waitForSync: true, forceVerify: true });

                    if (options.claim) {
                        const whitelist = await getMergedWhitelist();
                        const reclaimer = new Reclaimer(connection, operator, { whitelist });
                        await reclaimer.reclaimAllEligible();
                    }
                } catch (e: any) {
                    console.error(`❌ Cycle failed for ${operator.publicKey.toBase58().slice(0, 8)}: ${e.message}`);
                }
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
    .option('-a, --all', 'Run sweep for all operators in operators.json', false)
    .action(async (options) => {
        const connection = new Connection(RPC_URL, 'confirmed');
        const operators = getOperators(options);

        let totalReclaimed = 0;
        let totalAccounts = 0;

        for (const operator of operators) {
            console.log(`\n🧹 Sweeping operator ${operator.publicKey.toBase58().slice(0, 8)}...`);
            await initDbForOperator(operator.publicKey.toBase58());

            const scanner = new Discoverer(connection, operator.publicKey);
            const { stats } = await scanner.scan({ waitForSync: true, forceVerify: true });
            console.log(`✅ Scan complete. Tracked: ${stats.totalAccounts}`);
            totalAccounts += stats.totalAccounts;

            if (options.claim) {
                const whitelist = await getMergedWhitelist();
                const reclaimer = new Reclaimer(connection, operator, { whitelist });
                const result = await reclaimer.reclaimAllEligible();
                console.log(`💰 Reclaimed ${result.success} accounts, Total: ${result.sol.toFixed(4)} SOL`);
                totalReclaimed += result.sol;
            } else {
                const opStats = await getOperatorStats(operator.publicKey.toBase58());
                console.log(`💰 Reclaimable: ${opStats.reclaimableAccounts} (~${(opStats.reclaimableLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
            }
        }

        if (operators.length > 1) {
            console.log(`\n📊 TOTAL: ${totalAccounts} accounts across ${operators.length} operators`);
            if (options.claim) {
                console.log(`💰 Total Reclaimed: ${totalReclaimed.toFixed(4)} SOL`);
            } else {
                console.log(`💡 Run with --claim to recover rent.`);
            }
        }
    });

/**
 * 3. STATS (Analytics Mode)
 */
program.command('stats')
    .description('Show detailed performance report card')
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .option('-a, --all', 'Show report for all operators in operators.json', false)
    .action(async (options) => {
        const { generateReport } = require('./lib/report');
        const operators = getOperators(options);

        for (const operator of operators) {
            await initDbForOperator(operator.publicKey.toBase58());
            await generateReport(operator.publicKey.toBase58());
        }
    });
/**
 * 4. ACTIVITY (History Mode)
 */
program.command('activity')
    .description('Show recent reclamation activity')
    .option('-n, --number <count>', 'Number of entries to show', '20')
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .option('-a, --all', 'Show activity for all operators in operators.json', false)
    .action(async (options) => {
        const { getRecentActivity } = require('./lib/database');
        const operators = getOperators(options);
        const limit = parseInt(options.number);

        for (const operator of operators) {
            await initDbForOperator(operator.publicKey.toBase58());
            const activity = await getRecentActivity(limit);

            console.log(`\n📜 Activity Log for ${operator.publicKey.toBase58().slice(0, 8)}...`);
            console.log(`======================`);

            if (activity.length === 0) {
                console.log("No activity recorded yet.");
                continue;
            }

            activity.forEach((row: any) => {
                const date = new Date(row.timestamp).toLocaleString();
                const rent = (row.rent_paid / 1e9).toFixed(5);
                console.log(`[${date}] 💰 Reclaimed ${rent} SOL from ${row.pubkey.slice(0, 8)}...`);
            });
        }
    });

/**
 * 5. EXPORT (Data Dump)
 */
program.command('export')
    .description('Export full audit log to CSV')
    .option('-o, --output <file>', 'Output filename', 'audit_export.csv')
    .option('-w, --wallet <path>', 'Path to operator keypair file', OPERATOR_KEYPAIR_PATH)
    .option('-a, --all', 'Export logs for all operators in operators.json', false)
    .action(async (options) => {
        const { getAllAccounts } = require('./lib/database');
        const operators = getOperators(options);
        let totalExported = 0;

        for (const operator of operators) {
            await initDbForOperator(operator.publicKey.toBase58());
            const prefix = operator.publicKey.toBase58().slice(0, 8);
            const outputFile = operators.length > 1
                ? options.output.replace('.csv', `_${prefix}.csv`)
                : options.output;

            console.log(`\n📦 Exporting audit log for ${prefix}...`);
            const accounts = await getAllAccounts(operator.publicKey.toBase58());

            if (accounts.length === 0) {
                console.log("⚠️ No accounts found to export.");
                continue;
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
                        if (typeof val === 'number' && val < 100000000000) {
                            val = val * 1000;
                        }
                        return new Date(val).toISOString();
                    }
                    if (k === 'rentPaid') return (val / 1e9).toFixed(9);
                    if (val === null || val === undefined) return '';
                    return `"${String(val).replace(/"/g, '""')}"`;
                }).join(',');
            }).join('\n');

            fs.writeFileSync(outputFile, header + rows);
            console.log(`✅ Exported ${accounts.length} records to ${outputFile}`);
            totalExported += accounts.length;
        }

        if (operators.length > 1) {
            console.log(`\n📊 Total exported: ${totalExported} records across ${operators.length} operators`);
        }
    });

/**
 * 5. CONFIG (Management Mode)
 */
const config = program.command('config').description('Manage configuration and settings');

config.command('whitelist')
    .description('Manage address whitelist')
    .option('-w, --wallet <path>', 'Path to operator keypair file (required for whitelist operations)')
    .argument('<action>', 'add, remove, or list')
    .argument('[address]', 'Solana address')
    .argument('[note]', 'Optional note for the address')
    .action(async (action, address, note, options) => {
        // Whitelist needs an operator context for DB
        if (!options.wallet) {
            console.error('❌ Whitelist requires --wallet to specify operator DB.');
            process.exit(1);
        }
        const operator = loadKeypair(options.wallet);
        await initDbForOperator(operator.publicKey.toBase58());

        if (action === 'add') {
            if (!address) return console.error('❌ Address required');
            await addToWhitelist(address, note);
            console.log(`✅ Added ${address} to whitelist for ${operator.publicKey.toBase58().slice(0, 8)}...`);
        } else if (action === 'remove') {
            if (!address) return console.error('❌ Address required');
            await removeFromWhitelist(address);
            console.log(`✅ Removed ${address} from whitelist.`);
        } else {
            const list = await getWhitelist();
            console.log(`📋 Whitelisted Addresses for ${operator.publicKey.toBase58().slice(0, 8)}...`);
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
