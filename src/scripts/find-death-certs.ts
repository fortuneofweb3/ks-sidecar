
import { Connection, PublicKey } from '@solana/web3.js';
import { getClient, updateAccountStatus } from '../lib/database';

async function main() {
    console.log("🕵️‍♀️ Hunting for Death Certificates...");

    // 1. Get closed accounts missing death certs
    const db = getClient();
    const result = await db.execute("SELECT pubkey FROM sponsored_accounts WHERE status = 'closed' AND reclaimed_at IS NULL");

    if (result.rows.length === 0) {
        console.log("✅ All closed accounts have death certificates.");
        return;
    }

    const pubkeys = result.rows.map(r => r.pubkey as string);
    console.log(`Found ${pubkeys.length} ghosts without a time of death.`);

    const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(RPC_URL);

    let found = 0;

    for (const pubkeyStr of pubkeys) {
        try {
            // Get the very last transaction for this address
            // Even if closed, the history exists.
            const signatures = await connection.getSignaturesForAddress(new PublicKey(pubkeyStr), { limit: 1 });

            if (signatures.length === 0) {
                console.log(`⚠️  ${pubkeyStr}: No history found (RPC might have pruned it).`);
                continue;
            }

            const lastSig = signatures[0];
            const signature = lastSig.signature;
            const timestamp = (lastSig.blockTime || 0) * 1000; // Convert to ms

            console.log(`💀 Found Death Cert for ${pubkeyStr}:`);
            console.log(`   - Time: ${new Date(timestamp).toISOString()}`);
            console.log(`   - Sig:  ${signature}`);

            // Update DB
            // usage: updateAccountStatus(pubkey, status, reclaimedAt, reclaimSignature)
            await updateAccountStatus(pubkeyStr, 'reclaimed', timestamp, signature); // We mark 'reclaimed' so it shows up in stats as recovered (or kept as closed?)
            // Actually user asked for "death certs", implies reclaimed/closed. 
            // If we mark 'reclaimed', it implies WE reclaimed it. If someone else did, maybe 'closed' is better?
            // But 'reclaimed' status makes it show up in 'realized_rent' stats if we assume we did it or just tracking end of life.
            // Let's keep status as 'closed' but add the metadata. The function updateAccountStatus allows updating status.
            // Let's set it to 'closed' but with metadata.

            // Wait, updateAccountStatus implementation:
            // const sql = reclaimedAt && reclaimSignature
            //    ? 'UPDATE sponsored_accounts SET status = ?, last_checked = ?, reclaimed_at = ?, reclaim_signature = ? WHERE pubkey = ?'

            // So we can pass 'closed' as status.
            await updateAccountStatus(pubkeyStr, 'closed', timestamp, signature);
            found++;

            // Rate limit slightly for public RPCs
            await new Promise(r => setTimeout(r, 200));

        } catch (e: any) {
            console.error(`❌ Error for ${pubkeyStr}: ${e.message}`);
        }
    }

    console.log(`\n⚰️  Backfill complete. Found ${found}/${pubkeys.length} death certificates.`);
}

main().catch(console.error);
