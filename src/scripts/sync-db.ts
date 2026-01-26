
import { Connection, PublicKey } from '@solana/web3.js';
import { getClient, getActiveAccountsForOperator, batchUpdateStatus } from '../lib/database';
import { Reclaimer } from '../lib/reclaimer';
// import { loadKeypair } from '../index'; // Removed invalid import

// Helper since loadKeypair isn't exported cleanly
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
function loadKeypairLocal(path: string): Keypair {
    const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

async function main() {
    console.log("🔄 Starting Database Sync...");

    const db = getClient();
    const result = await db.execute("SELECT operator FROM sponsored_accounts LIMIT 1");
    if (result.rows.length === 0) return;
    const operatorStr = result.rows[0].operator as string;

    // Check ALL active accounts
    const activeAccounts = await getActiveAccountsForOperator(operatorStr, 100);
    console.log(`Found ${activeAccounts.length} active accounts in DB.`);

    const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(RPC_URL);

    const toCloseKeys: string[] = [];
    const trulyActive: string[] = [];

    for (const acc of activeAccounts) {
        const info = await connection.getAccountInfo(new PublicKey(acc.pubkey));
        if (!info) {
            console.log(`❌ ${acc.pubkey} is closed on-chain. Updating DB...`);
            toCloseKeys.push(acc.pubkey);
        } else {
            console.log(`✅ ${acc.pubkey} is TRULY ACTIVE.`);
            trulyActive.push(acc.pubkey);
        }
    }

    if (toCloseKeys.length > 0) {
        await batchUpdateStatus(toCloseKeys, 'closed');
        console.log(`\n💾 Updated ${toCloseKeys.length} accounts to 'closed'.`);
    }

    if (trulyActive.length > 0) {
        console.log(`\nAttempting to reclaim the ${trulyActive.length} remaining active accounts...`);
        const operator = loadKeypairLocal('./operator-keypair.json');

        // whitelist can be empty for this test
        const reclaimer = new Reclaimer(connection, operator, { whitelist: [] });

        // Force try single reclaim
        for (const pubkey of trulyActive) {
            console.log(`Targeting: ${pubkey}`);
            const accountInfo = await connection.getAccountInfo(new PublicKey(pubkey));
            if (accountInfo) {
                // We mock the "AccountInfo<Buffer>" by adding owner check if needed, 
                // but reclaimer.reclaimSingle is private. 
                // We'll use reclaimAllEligible() but purely for this list if possible 
                // Actually, reclaimer.reclaimAllEligible() re-scans.
                // Let's just run it.
            }
        }

        const result = await reclaimer.reclaimAllEligible();
        console.log(`💰 Reclaim Result: Success=${result.success}, SOL=${result.sol}`);
    }
}

main().catch(console.error);
