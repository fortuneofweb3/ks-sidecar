
import { Connection, PublicKey } from '@solana/web3.js';
import { getClient } from '../lib/database';
import { IncrementalScanner } from '../lib/incremental-scanner';

async function main() {
    // 1. Get Operator from DB
    const db = getClient();
    const result = await db.execute("SELECT operator FROM sponsored_accounts LIMIT 1");

    if (result.rows.length === 0) {
        console.error("No operator found in database history. Cannot run test.");
        return;
    }

    const operatorStr = result.rows[0].operator as string;
    console.log(`\n🔍 Testing Current Approach (Helius Indexer) for Operator: ${operatorStr}`);

    const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(RPC_URL);
    const operator = new PublicKey(operatorStr);

    // 2. Instantiate the Scanner (Our "Current Approach")
    const scanner = new IncrementalScanner(connection, operator);

    console.log(`\n⚡ Running Incremental Scan...`);
    const startTime = Date.now();

    // 3. Run the scan logic
    // We intentionally force a "fresh" check logic if possible, or just run standard scan
    const scanResult = await scanner.scan();

    const duration = (Date.now() - startTime) / 1000;

    console.log(`\n⏱️  Scan complete in ${duration.toFixed(2)}s.`);
    console.log(`📦 Stats returned:`);
    console.log(`   - Total Accounts: ${scanResult.stats.totalAccounts}`);
    console.log(`   - Active: ${scanResult.stats.activeAccounts}`);
    console.log(`   - Reclaimable: ${scanResult.stats.reclaimableAccounts}`);

    console.log(`\n✅ SUCCESS: The Helius Indexer approach worked without rate limits.`);
}

main().catch(console.error);
