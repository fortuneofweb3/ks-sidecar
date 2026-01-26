
import { Connection } from '@solana/web3.js';
import { getClient, batchUpdateAccountMetadata } from '../lib/database';
import { heliusClient } from '../lib/helius';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

async function main() {
    console.log("🔍 Starting Metadata Backfill...");

    // 1. Find accounts with missing Source
    const db = getClient();
    const result = await db.execute("SELECT pubkey, signature FROM sponsored_accounts WHERE sponsorship_source IS NULL OR sponsorship_source = ''");

    if (result.rows.length === 0) {
        console.log("✅ No accounts need backfill.");
        return;
    }

    console.log(`Found ${result.rows.length} accounts missing metadata.`);

    const signatures: string[] = result.rows.map(r => r.signature as string);
    const pubkeyMap = new Map<string, string>();
    result.rows.forEach(r => pubkeyMap.set(r.signature as string, r.pubkey as string));

    // 2. Fetch from Helius (Batch 100)
    // Note: Helius parseTransactions takes up to 100 signatures
    const chunks = [];
    for (let i = 0; i < signatures.length; i += 100) {
        chunks.push(signatures.slice(i, i + 100));
    }

    for (const chunk of chunks) {
        console.log(`Processing batch of ${chunk.length}...`);
        try {
            const txs = await heliusClient.parseTransactions(chunk);

            const updates: any[] = [];

            for (const tx of txs) {
                const pubkey = pubkeyMap.get(tx.signature);
                if (!pubkey) continue;

                let memo = '';
                // 1. Extract Memo
                for (const ix of tx.instructions || []) {
                    if (ix.programId === 'MemoSq4gqQmJv9jF8gA9y5L5j5q7y5L5j5q7y5L5j5q7') {
                        if (ix.data) {
                            try {
                                // Simple logic: if data is base58/base64, we might need decoding
                                // Helius often gives 'parsed' for memo check documentation
                                // For now, save raw or 'Present'
                                // If Helius returns it in 'instructions', checking 'data'
                                memo = ix.data; // Saving raw for now
                            } catch { }
                        }
                    }
                }

                updates.push({
                    pubkey,
                    initialTimestamp: tx.timestamp,
                    sponsorshipSource: tx.source || 'UNKNOWN',
                    memo
                });
            }

            if (updates.length > 0) {
                await batchUpdateAccountMetadata(updates);
                console.log(`✅ Updated ${updates.length} accounts.`);
            }

        } catch (e: any) {
            console.error(`❌ Batch failed: ${e.message}`);
        }
    }

    console.log("🎉 Backfill Complete.");
}

main().catch(console.error);
