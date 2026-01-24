import 'dotenv/config';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Command } from 'commander';
import fs from 'fs';
import { initDb, batchUpsertAccounts, getOperatorStats } from './lib/database';
import { IncrementalScanner } from './lib/incremental-scanner';
import { Reclaimer } from './lib/reclaimer';
import { Analyzer } from './lib/analyzer';

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const OPERATOR_KEYPAIR_PATH = process.env.OPERATOR_KEYPAIR_PATH || './operator-keypair.json';
const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL_HOURS || '2') * 60 * 60 * 1000;

// FORCED LOCAL DATABASE FOR SIDECAR (No cloud connection by default)
if (!process.env.LOCAL_DB_PATH) {
    process.env.LOCAL_DB_PATH = 'korascan_local.db';
}

const program = new Command();

function loadKeypair(path: string): Keypair {
    try {
        const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
        return Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch (e) {
        console.error(`Failed to load keypair from ${path}`);
        process.exit(1);
    }
}

// ensureInit is removed, use initDb directly

function loadWhitelist(): string[] {
    try {
        if (fs.existsSync('whitelist.json')) {
            const data = JSON.parse(fs.readFileSync('whitelist.json', 'utf-8'));
            if (Array.isArray(data)) return data;
        }
    } catch (e) {
        console.warn('⚠️  Could not load whitelist.json. Proceeding without filters.');
    }
    return [];
}

program
    .name('korascan-sidecar')
    .description('KoraScan Sidecar - Local-first rent reclamation')
    .version('1.0.0');

program.command('init')
    .description('Initialize local database')
    .action(async () => {
        await initDb();
        console.log('✅ Local database initialized.');
    });

program.command('scan')
    .description('Scan for sponsored accounts (Local discovery)')
    .option('--history', 'Use Helius history for exhaustive discovery (requires HELIUS_API_KEY)', false)
    .action(async (options) => {
        await initDb();
        const connection = new Connection(RPC_URL, 'confirmed');
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);

        console.log(`🔍 Starting scan...`);
        console.log(`📡 RPC: ${RPC_URL}`);
        console.log(`👤 Operator: ${operator.publicKey.toBase58()}`);

        if (options.history && !process.env.HELIUS_API_KEY) {
            console.warn('⚠️  History scan requested but HELIUS_API_KEY is missing. Falling back to Direct scan.');
        }

        if (options.history && process.env.HELIUS_API_KEY) {
            const scanner = new IncrementalScanner(connection, operator.publicKey);
            const { stats } = await scanner.scan();
            console.log(`✅ History scan complete.`);
            console.log(`📦 Tracked: ${stats.totalAccounts}`);
        } else {
            console.log('⚡ Using Direct Scan (Paginated)...');
            const heliusClient = process.env.HELIUS_API_KEY ? new (require('./lib/helius').HeliusClient)() : null;
            const analyzer = new Analyzer(connection, operator.publicKey, false, heliusClient);
            const reclaimable = await analyzer.findReclaimableAccountsDirect();

            const toSave = reclaimable.map(a => ({
                pubkey: a.pubkey,
                operator: operator.publicKey.toBase58(),
                userWallet: a.userWallet,
                mint: '',
                type: a.type,
                rentPaid: a.lamports,
                signature: 'DIRECT_SCAN_LOCAL',
                slot: 0,
                status: 'reclaimable'
            }));

            await batchUpsertAccounts(toSave as any);
            console.log(`✅ Direct scan complete. Found ${reclaimable.length} reclaimable accounts.`);
        }
    });

program.command('status')
    .description('Show current local stats')
    .action(async () => {
        await initDb();
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);
        const stats = await getOperatorStats(operator.publicKey.toBase58());

        console.log(`📊 KoraScan Status (Local DB)\n`);
        console.log(`👤 Operator: ${operator.publicKey.toBase58()}`);
        console.log(`📦 Total tracked: ${stats.totalAccounts}`);
        console.log(`💰 Reclaimable: ${stats.reclaimableAccounts} (~${(stats.reclaimableLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
    });

program.command('reclaim')
    .description('Reclaim rent from eligible accounts in local DB')
    .option('--dry-run', 'Simulate reclamation without sending transactions', false)
    .option('--whitelist <path>', 'Path to custom whitelist JSON')
    .action(async (options) => {
        await initDb();
        const connection = new Connection(RPC_URL, 'confirmed');
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);
        const whitelist = options.whitelist ? JSON.parse(fs.readFileSync(options.whitelist, 'utf-8')) : loadWhitelist();

        console.log(`💰 [KoraScan] Reclaiming rent from discoveries...`);

        const reclaimer = new Reclaimer(connection, operator, {
            dryRun: options.dryRun,
            whitelist: whitelist
        });
        await reclaimer.reclaimAllEligible();
    });

program.command('sweep')
    .description('Full cycle: scan + reclaim')
    .option('--dry-run', 'Simulate sweep without sending transactions', false)
    .action(async (options) => {
        await initDb();
        const connection = new Connection(RPC_URL, 'confirmed');
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);
        const whitelist = loadWhitelist();

        console.log(`🔄 Starting KoraScan sweep cycle...`);

        // 1. Scan (Incremental)
        const scanner = new IncrementalScanner(connection, operator.publicKey);
        const { stats } = await scanner.scan();
        console.log(`✅ Discovered ${stats.reclaimableAccounts} reclaimable accounts.`);

        if (stats.reclaimableAccounts === 0) {
            console.log(`✅ Nothing to reclaim.`);
            return;
        }

        // 2. Reclaim
        const reclaimer = new Reclaimer(connection, operator, {
            dryRun: options.dryRun,
            whitelist: whitelist
        });
        await reclaimer.reclaimAllEligible();
    });

program.command('monitor')
    .description('Continuous monitoring loop')
    .option('-i, --interval <hours>', 'Check interval in hours', '2')
    .option('--dry-run', 'Simulate actions in monitoring loop', false)
    .action(async (options) => {
        await initDb();
        const connection = new Connection(RPC_URL, 'confirmed');
        const operator = loadKeypair(OPERATOR_KEYPAIR_PATH);
        const whitelist = loadWhitelist();
        const interval = parseFloat(options.interval) * 60 * 60 * 1000;

        console.log(`👁️ Starting Monitor Mode...`);
        if (options.dryRun) console.log(`🛡️ [Dry Run] No actual transactions will be signed.`);
        console.log(`⏱️ Interval: ${options.interval} hours\n`);

        const runCheck = async () => {
            console.log(`[${new Date().toISOString()}] Refreshing scan...`);
            try {
                const scanner = new IncrementalScanner(connection, operator.publicKey);
                const { stats } = await scanner.scan();

                if (stats.reclaimableAccounts > 0) {
                    const reclaimer = new Reclaimer(connection, operator, {
                        dryRun: options.dryRun,
                        whitelist: whitelist
                    });
                    const result = await reclaimer.reclaimAllEligible();

                    const action = options.dryRun ? "Simulated" : "Actual";
                    console.log(`[${action}] reclaim: ${result.success} accounts, SOL: ${result.sol.toFixed(4)}`);
                } else {
                    console.log(`No reclaimable accounts found.`);
                }
            } catch (e: any) {
                console.error(`Monitor check failed: ${e.message}`);
            }
        };

        await runCheck();
        setInterval(runCheck, interval);
        console.log(`\nMonitor running. Press Ctrl+C to stop.`);
    });

program.parse();
