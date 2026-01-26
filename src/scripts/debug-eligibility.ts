
import { Connection, PublicKey } from '@solana/web3.js';
import { getClient, getActiveAccountsForOperator } from '../lib/database';
import { Analyzer } from '../lib/analyzer';

async function main() {
    console.log("🔍 Debugging Eligibility...");

    // 1. Get from DB
    const db = getClient();
    const result = await db.execute("SELECT operator FROM sponsored_accounts LIMIT 1");
    if (result.rows.length === 0) return console.error("No operator.");
    const operatorStr = result.rows[0].operator as string;

    const activeAccounts = await getActiveAccountsForOperator(operatorStr, 10);
    console.log(`Found ${activeAccounts.length} active accounts in DB.`);

    if (activeAccounts.length === 0) {
        console.log("No active accounts to check.");
        return;
    }

    // 2. Run Analyzer Logic Step-by-Step
    const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(RPC_URL);
    const analyzer = new Analyzer(connection, new PublicKey(operatorStr));

    console.log(`Checking eligibility for all ${activeAccounts.length} accounts...`);

    let closedCount = 0;

    for (const singleCheck of activeAccounts) {
        // Map DB object to DiscoveredAccount shape
        const discovered = {
            ...singleCheck,
            timestamp: singleCheck.initialTimestamp || 0,
            sponsorshipSource: singleCheck.sponsorshipSource || 'UNKNOWN',
            memo: singleCheck.memo || '',
            type: singleCheck.type as 'token' | 'token-2022' | 'system'
        };

        console.log(`\n🔎 Inspecting On-Chain Data for ${singleCheck.pubkey}:`);
        try {
            const info = await connection.getAccountInfo(new PublicKey(singleCheck.pubkey));
            if (!info) {
                console.log("   ❌ Account closed before inspection.");
                continue;
            }

            // Manual Decode of Token Account (Offset 106 is Close Authority)
            // Layout: Mint(32) + Owner(32) + Amount(8) + DelegateOption(4) + Delegate(32) + State(1) + IsNativeOption(4) + IsNative(8) + DelegatedAmount(8) + CloseAuthorityOption(4) + CloseAuthority(32)
            // Offsets: 0-32 (Mint), 32-64 (Owner), 64-72 (Amount)
            // ... Close Authority Option is at 4+32+32+8+4+32+1+4+8+8 = 133? No, let's use standard known offsets.
            // Standard Token Account size = 165
            // Mint (0), Owner (32), Amount (64), DelegateOption (72), Delegate (76), State (108), IsNativeOption (109), IsNative (113), DelegatedAmount (121), CloseAuthorityOption (129), CloseAuthority (133)

            const amount = info.data.readBigUInt64LE(64);
            const closeAuthorityOption = info.data.readUInt32LE(129);
            const closeAuthority = new PublicKey(info.data.subarray(133, 165)).toBase58();

            console.log(`   💰 Token Amount: ${amount.toString()}`);
            console.log(`   🔑 Close Auth Option: ${closeAuthorityOption}`);
            console.log(`   👤 Close Authority: ${closeAuthority}`);
            console.log(`   🤖 Expected Operator: ${operatorStr}`);

            if (closeAuthorityOption === 1 && closeAuthority === operatorStr) {
                console.log("   ✅ MATCH! This account SHOULD be reclaimable.");
            } else {
                console.log("   🚫 MISMATCH! We do not have authority to close this.");
            }

        } catch (e: any) {
            console.log(`   ⚠️ Decode failed: ${e.message}`);
        }
        // Check Analyzer result
        const findings = await analyzer.analyzeAccounts([discovered]);
        const finding = findings.find(f => f.pubkey === singleCheck.pubkey);

        console.log(`\n🤖 Analyzer Verdict for ${singleCheck.pubkey}:`);
        console.log(`   - Status: ${finding?.status}`);

        // Manual check of token data to see if balance > 0
        try {
            // Need to import Layout to decode, but simplified check:
            // If analyzer says 'locked', it usually means balance > 0 or close authority mismatch
            if (finding?.status === 'locked') {
                console.log("   🔒 Reason: Locked. Likely has TOKEN BALANCE > 0.");
            } else if (finding?.status === 'reclaimable') {
                console.log("   ✅ Reclaimable.");
            } else {
                console.log(`   ❓ Status is ${finding?.status}`);
            }
        } catch (e) { }
    }

    if (closedCount === activeAccounts.length) {
        console.log("\nCONCLUSION: ALL accounts are already closed on-chain.");
        console.log("ACTION: We need to run a 'Sync' to update the database status to 'closed'.");
    }
}

main().catch(console.error);
