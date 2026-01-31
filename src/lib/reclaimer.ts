import {
    Connection,
    Keypair,
    Transaction,
    PublicKey,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
    AccountInfo,
    SystemProgram
} from '@solana/web3.js';
import {
    createCloseAccountInstruction,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    AccountLayout
} from '@solana/spl-token';
import { updateAccountStatus, getReclaimableAccounts, batchUpdateAccountMetadata } from './database';
import { sendNotification } from './notifier';

const PRIORITY_FEE_MICRO_LAMPORTS = parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS || '10000');
const BATCH_SIZE = parseInt(process.env.RECLAIM_BATCH_SIZE || '15');
const TOKEN_PROGRAM_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_STR = 'TokenzQdBNbAtYpYbt9UEHJR9YWYvNf2t8S77tB39L';

// SAFETY CONFIGURATION
// If not set, features are DISABLED.
const RECLAIM_COOL_DOWN_DAYS = process.env.RECLAIM_COOL_DOWN_DAYS ? parseFloat(process.env.RECLAIM_COOL_DOWN_DAYS) : 0;
const RECLAIM_CIRCUIT_BREAKER_SOL = process.env.RECLAIM_CIRCUIT_BREAKER_SOL ? parseFloat(process.env.RECLAIM_CIRCUIT_BREAKER_SOL) : 0;
// Treasury Config
const TREASURY_WALLET = process.env.TREASURY_WALLET; // Optional: Forward profits here
const TREASURY_MIN_SOL = process.env.TREASURY_MIN_SOL ? parseFloat(process.env.TREASURY_MIN_SOL) : 0.5; // Min balance before sweeping

interface AccountWithInfo {
    pubkey: PublicKey;
    info: AccountInfo<Buffer>;
}

export class Reclaimer {
    private connection: Connection;
    private operatorKeypair: Keypair;
    private dryRun: boolean;
    private whitelist: Set<string>;

    constructor(connection: Connection, operatorKeypair: Keypair, options: { dryRun?: boolean, whitelist?: string[] } = {}) {
        this.connection = connection;
        this.operatorKeypair = operatorKeypair;
        this.dryRun = options.dryRun || false;
        this.whitelist = new Set(options.whitelist || []);

        if (this.dryRun) {
            console.log("[KoraScan] [DRY RUN] ACTIVE - No transactions will be sent.");
        }

        // Log Safety Configuration
        if (RECLAIM_COOL_DOWN_DAYS > 0) {
            console.log(`[Safety] 🛡️ Cool-Down Active: ${RECLAIM_COOL_DOWN_DAYS} days`);
        } else {
            console.log(`[Safety] ⚠️ Cool-Down DISABLED (RECLAIM_COOL_DOWN_DAYS not set)`);
        }

        if (RECLAIM_CIRCUIT_BREAKER_SOL > 0) {
            console.log(`[Safety] 🛡️ Circuit Breaker Active: > ${RECLAIM_CIRCUIT_BREAKER_SOL} SOL`);
        } else {
            console.log(`[Safety] ⚠️ Circuit Breaker DISABLED (RECLAIM_CIRCUIT_BREAKER_SOL not set)`);
        }

        if (TREASURY_WALLET) {
            console.log(`[Config] 🏦 Treasury Auto-Forwarding ACTIVE -> ${TREASURY_WALLET} (Min: ${TREASURY_MIN_SOL} SOL)`);
        }
    }

    /**
     * Reclaim all eligible accounts from database
     */
    async reclaimAllEligible(): Promise<{ success: number; failed: number; sol: number }> {
        const reclaimableAccounts = await getReclaimableAccounts();

        console.log(`[Safety] Checking ${reclaimableAccounts.length} potentially reclaimable accounts...`);

        // 1. Filter by Whitelist
        const nonWhitelisted = reclaimableAccounts.filter(acc => !this.whitelist.has(acc.pubkey));

        let eligible = nonWhitelisted;

        // 2. Filter by Cool-Down (IF ENABLED)
        if (RECLAIM_COOL_DOWN_DAYS > 0) {
            const now = Date.now();
            const minAgeMs = RECLAIM_COOL_DOWN_DAYS * 24 * 60 * 60 * 1000;

            eligible = nonWhitelisted.filter(acc => {
                if (!acc.closedAt) return true; // Account missing closed_at, skip check? Or strict? 
                // Assuming safe to proceed if data missing for legacy reasons, 
                // or strictly require manual review? 
                // Existing logic was permissive for legacy, let's keep it.
                return (now - acc.closedAt) >= minAgeMs;
            });

            const skippedCoolDown = nonWhitelisted.length - eligible.length;
            if (skippedCoolDown > 0) {
                console.log(`[Safety] Skipped ${skippedCoolDown} accounts in ${RECLAIM_COOL_DOWN_DAYS}-day cool-down period.`);
            }
        }

        if (eligible.length === 0) {
            console.log("[KoraScan] No accounts eligible for reclaim.");
            // Even if no reclaims, check if we need to sweep (e.g. from previous runs)
            await this.sweepProfitToTreasury();
            return { success: 0, failed: 0, sol: 0 };
        }

        console.log(`[KoraScan] Processing ${eligible.length} eligible accounts...`);
        const pubkeys = eligible.map(acc => acc.pubkey);
        const result = await this.reclaimAccounts(pubkeys);

        // Auto-Sweep Profit
        await this.sweepProfitToTreasury();

        return result;
    }

    /**
     * Auto-sweeps excess SOL from hot wallet to Treasury
     */
    private async sweepProfitToTreasury() {
        if (!TREASURY_WALLET || this.dryRun) return;

        try {
            const balance = await this.connection.getBalance(this.operatorKeypair.publicKey);
            const balanceSol = balance / 1e9;
            const minSol = TREASURY_MIN_SOL;
            const keepSol = 0.1; // Keep 0.1 SOL for gas

            if (balanceSol > minSol) {
                const amountToSend = balanceSol - keepSol;
                if (amountToSend <= 0) return;

                console.log(`[Treasury] 💰 Sweeping profit: ${amountToSend.toFixed(4)} SOL -> ${TREASURY_WALLET}`);

                const tx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: this.operatorKeypair.publicKey,
                        toPubkey: new PublicKey(TREASURY_WALLET),
                        lamports: Math.floor(amountToSend * 1e9)
                    })
                );

                const sig = await sendAndConfirmTransaction(this.connection, tx, [this.operatorKeypair]);
                console.log(`[Treasury] ✅ Sweep Complete: ${sig}`);
            }
        } catch (e: any) {
            console.error(`[Treasury] ⚠️ Sweep failed: ${e.message}`);
        }
    }

    /**
     * Reclaim specific accounts by pubkey
     */
    async reclaimAccounts(pubkeyStrs: string[]): Promise<{ success: number; failed: number; sol: number }> {
        let totalSuccess = 0;
        let totalFailed = 0;
        let totalSol = 0;

        // 1. FAST: Pre-fetch ALL account info (Double-Tap Check)
        console.log(`[KoraScan] Pre-fetching ${pubkeyStrs.length} accounts...`);
        const accountsWithInfo = await this.batchFetchAccounts(pubkeyStrs);

        console.log(`[KoraScan] ${accountsWithInfo.length} accounts verified. Batching for reclaim...`);

        // 2. Process in transaction batches
        for (let i = 0; i < accountsWithInfo.length; i += BATCH_SIZE) {
            const batch = accountsWithInfo.slice(i, i + BATCH_SIZE);
            const result = await this.reclaimBatch(batch);

            totalSuccess += result.success;
            totalFailed += result.failed;
            totalSol += result.sol;
        }

        const actionStr = this.dryRun ? "SIMULATED" : "ACTUAL";
        console.log(`[KoraScan] Reclaim [${actionStr}] complete. Success: ${totalSuccess}, Failed: ${totalFailed}, SOL: ${totalSol.toFixed(4)}`);
        return { success: totalSuccess, failed: totalFailed, sol: totalSol };
    }

    /**
     * FAST: Batch fetch account info using getMultipleAccountsInfo
     * Also verifies token balance is ZERO (Safety)
     */
    private async batchFetchAccounts(pubkeyStrs: string[]): Promise<AccountWithInfo[]> {
        const results: AccountWithInfo[] = [];
        const FETCH_BATCH_SIZE = 100;

        for (let i = 0; i < pubkeyStrs.length; i += FETCH_BATCH_SIZE) {
            const batch = pubkeyStrs.slice(i, i + FETCH_BATCH_SIZE);
            const pubkeys: PublicKey[] = [];

            for (const str of batch) {
                if (this.whitelist.has(str)) continue;
                try {
                    pubkeys.push(new PublicKey(str));
                } catch {
                    console.warn(`[KoraScan] Invalid pubkey: ${str}`);
                }
            }

            if (pubkeys.length === 0) continue;

            try {
                const infos = await this.connection.getMultipleAccountsInfo(pubkeys);

                for (let j = 0; j < infos.length; j++) {
                    const info = infos[j];
                    const pubkeyStr = pubkeys[j].toBase58();

                    if (!info) {
                        // Account doesn't exist? Already closed.
                        if (!this.dryRun) await updateAccountStatus(pubkeyStr, 'closed');
                        continue;
                    }

                    const ownerStr = info.owner.toBase58();
                    const isToken = ownerStr === TOKEN_PROGRAM_STR || ownerStr === TOKEN_2022_PROGRAM_STR;

                    if (isToken) {
                        // Double-Tap Verification: Check Token Balance
                        try {
                            const decoded = AccountLayout.decode(info.data);
                            if (decoded.amount > BigInt(0)) {
                                console.warn(`[Safety] Skipping ${pubkeyStr} - Non-zero token balance!`);
                                // Mark as active or error?
                                if (!this.dryRun) await batchUpdateAccountMetadata([{
                                    pubkey: pubkeyStr,
                                    status: 'active',
                                    errorMessage: 'Revived: Non-zero token balance'
                                }]);
                                continue;
                            }
                        } catch (e) {
                            console.warn(`[Safety] Failed to decode token data for ${pubkeyStr}, skipping.`);
                            continue;
                        }

                        results.push({
                            pubkey: pubkeys[j],
                            info: info
                        });
                    } else {
                        console.log(`[KoraScan] Skipped ${pubkeyStr} (Non-token: ${ownerStr})`);
                        if (!this.dryRun) await updateAccountStatus(pubkeyStr, 'active');
                    }
                }
            } catch (e) {
                console.error(`[KoraScan] Batch fetch failed:`, e);
            }

            if (i + FETCH_BATCH_SIZE < pubkeyStrs.length) {
                await new Promise(r => setTimeout(r, 50));
            }
        }

        return results;
    }

    /**
     * Reclaim a batch of pre-fetched accounts
     */
    private async reclaimBatch(accounts: AccountWithInfo[]): Promise<{ success: number; failed: number; sol: number }> {
        if (accounts.length === 0) {
            return { success: 0, failed: 0, sol: 0 };
        }

        const potentialSol = accounts.reduce((sum, a) => sum + a.info.lamports, 0) / 1e9;

        // Circuit Breaker Check (IF ENABLED)
        if (RECLAIM_CIRCUIT_BREAKER_SOL > 0 && potentialSol > RECLAIM_CIRCUIT_BREAKER_SOL && !this.dryRun) {
            console.error(`[Safety] 🚨 CIRCUIT BREAKER TRIPPED! Batch value ${potentialSol.toFixed(4)} SOL > Limit ${RECLAIM_CIRCUIT_BREAKER_SOL} SOL.`);
            console.error(`[Safety] Aborting batch to prevent loss.`);
            // Update DB with error
            const updates = accounts.map(a => ({
                pubkey: a.pubkey.toBase58(),
                status: 'error',
                errorMessage: 'Circuit Breaker Tripped'
            }));
            await batchUpdateAccountMetadata(updates);
            return { success: 0, failed: accounts.length, sol: 0 };
        }

        if (this.dryRun) {
            console.log(`[KoraScan] [DRY RUN] Would reclaim batch of ${accounts.length} accounts (~${potentialSol.toFixed(4)} SOL)`);
            return { success: accounts.length, failed: 0, sol: potentialSol };
        }

        console.log(`[KoraScan] Reclaiming batch of ${accounts.length} accounts...`);

        try {
            const tx = new Transaction();
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: PRIORITY_FEE_MICRO_LAMPORTS
            }));

            let totalLamports = 0;
            const validPubkeys: string[] = [];

            for (const { pubkey, info } of accounts) {
                const ownerStr = info.owner.toBase58();
                const programId = ownerStr === TOKEN_2022_PROGRAM_STR ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

                tx.add(createCloseAccountInstruction(
                    pubkey,
                    this.operatorKeypair.publicKey,
                    this.operatorKeypair.publicKey,
                    [],
                    programId
                ));

                totalLamports += info.lamports;
                validPubkeys.push(pubkey.toBase58());
            }

            if (validPubkeys.length === 0) {
                return { success: 0, failed: 0, sol: 0 };
            }

            const signature = await sendAndConfirmTransaction(
                this.connection,
                tx,
                [this.operatorKeypair],
                { skipPreflight: true, commitment: 'confirmed' }
            );

            console.log(`[KoraScan] Batch success! Sig: ${signature} | Reclaimed: ${(totalLamports / 1e9).toFixed(4)} SOL`);

            // Send notification (fire and forget)
            sendNotification(totalLamports / 1e9, validPubkeys.length, signature);

            // Update database with detailed audit info
            const reclaimedAmount = totalLamports / 1e9;
            await batchUpdateAccountMetadata(validPubkeys.map(pk => ({
                pubkey: pk,
                status: 'reclaimed',
                reclaimedAmount: 0, // Individual amount not tracked easily here without map, defaulting 0 or maybe roughly avg? 
                // Actually better to not set if we can't be precise, or assume rentExemptMin? 
                // Let's leave undefined or 0.
                // Wait, we have info.lamports available in the loop. We should use it.
            })));

            // Re-loop to update with correct amounts
            for (const { pubkey, info } of accounts) {
                if (validPubkeys.includes(pubkey.toBase58())) {
                    // We can do this async/background
                    updateAccountStatus(pubkey.toBase58(), 'reclaimed', Date.now(), signature); // Legacy compat
                    // Plus metadata
                    await batchUpdateAccountMetadata([{
                        pubkey: pubkey.toBase58(),
                        reclaimedAmount: info.lamports
                    }]);
                }
            }

            return {
                success: validPubkeys.length,
                failed: 0,
                sol: totalLamports / 1e9
            };

        } catch (e: any) {
            console.error(`[KoraScan] Batch reclaim failed: ${e.message}`);

            // Try individual reclaims on failure
            let success = 0;
            let failed = 0;
            let sol = 0;

            for (const { pubkey, info } of accounts) {
                try {
                    const result = await this.reclaimSingle(pubkey, info);
                    if (result.success) {
                        success++;
                        sol += result.lamports;
                    } else {
                        failed++;
                    }
                } catch {
                    failed++;
                }
            }

            return { success, failed, sol };
        }
    }

    /**
     * Reclaim a single account (fallback for failed batches)
     */
    private async reclaimSingle(pubkey: PublicKey, info: AccountInfo<Buffer>): Promise<{ success: boolean, lamports: number }> {
        if (this.dryRun) return { success: true, lamports: info.lamports / 1e9 };

        try {
            const tx = new Transaction();
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: PRIORITY_FEE_MICRO_LAMPORTS
            }));

            const ownerStr = info.owner.toBase58();
            const programId = ownerStr === TOKEN_2022_PROGRAM_STR ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

            tx.add(createCloseAccountInstruction(
                pubkey,
                this.operatorKeypair.publicKey,
                this.operatorKeypair.publicKey,
                [],
                programId
            ));

            const signature = await sendAndConfirmTransaction(
                this.connection,
                tx,
                [this.operatorKeypair],
                { skipPreflight: true, commitment: 'confirmed' }
            );

            await updateAccountStatus(pubkey.toBase58(), 'reclaimed', Date.now(), signature);
            await batchUpdateAccountMetadata([{
                pubkey: pubkey.toBase58(),
                reclaimedAmount: info.lamports
            }]);

            return { success: true, lamports: info.lamports / 1e9 };

        } catch (e: any) {
            console.error(`[KoraScan] Single reclaim failed for ${pubkey.toBase58()}: ${e.message}`);
            await batchUpdateAccountMetadata([{
                pubkey: pubkey.toBase58(),
                status: 'error',
                errorMessage: e.message
            }]);
            return { success: false, lamports: 0 };
        }
    }
}
