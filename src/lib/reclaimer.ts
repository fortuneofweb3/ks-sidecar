import {
    Connection,
    Keypair,
    Transaction,
    PublicKey,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
    AccountInfo
} from '@solana/web3.js';
import { createCloseAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { updateAccountStatus, getReclaimableAccounts } from './database';
import { sendNotification } from './notifier';

// ... imports ...



const PRIORITY_FEE_MICRO_LAMPORTS = parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS || '10000');
const BATCH_SIZE = parseInt(process.env.RECLAIM_BATCH_SIZE || '15'); // Safe number of instructions per transaction
const TOKEN_PROGRAM_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_STR = 'TokenzQdBNbAtYpYbt9UEHJR9YWYvNf2t8S77tB39L';

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
    }

    /**
     * Reclaim all eligible accounts from database
     */
    async reclaimAllEligible(): Promise<{ success: number; failed: number; sol: number }> {
        const reclaimableAccounts = await getReclaimableAccounts();

        // Apply whitelist filter immediately
        const filtered = reclaimableAccounts.filter(acc => !this.whitelist.has(acc.pubkey));
        const whitelistedCount = reclaimableAccounts.length - filtered.length;

        if (whitelistedCount > 0) {
            console.log(`[KoraScan] Ignored ${whitelistedCount} whitelisted accounts.`);
        }

        if (filtered.length === 0) {
            console.log("[KoraScan] No accounts eligible for reclaim (after whitelisting).");
            return { success: 0, failed: 0, sol: 0 };
        }

        console.log(`[KoraScan] Found ${filtered.length} reclaimable accounts. Processing...`);

        const pubkeys = filtered.map(acc => acc.pubkey);
        return this.reclaimAccounts(pubkeys);
    }

    /**
     * Reclaim specific accounts by pubkey
     */
    async reclaimAccounts(pubkeyStrs: string[]): Promise<{ success: number; failed: number; sol: number }> {
        let totalSuccess = 0;
        let totalFailed = 0;
        let totalSol = 0;

        // 1. FAST: Pre-fetch ALL account info in batches of 100
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
                    if (!this.dryRun) await updateAccountStatus(str, 'closed');
                }
            }

            if (pubkeys.length === 0) continue;

            try {
                const infos = await this.connection.getMultipleAccountsInfo(pubkeys);

                for (let j = 0; j < infos.length; j++) {
                    const info = infos[j];
                    const pubkeyStr = pubkeys[j].toBase58();

                    if (!info) {
                        if (!this.dryRun) await updateAccountStatus(pubkeyStr, 'closed');
                        continue;
                    }

                    const ownerStr = info.owner.toBase58();
                    const isToken = ownerStr === TOKEN_PROGRAM_STR || ownerStr === TOKEN_2022_PROGRAM_STR;

                    if (isToken) {
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

        if (this.dryRun) {
            const potentialSol = accounts.reduce((sum, a) => sum + a.info.lamports, 0) / 1e9;
            console.log(`[KoraScan] [DRY RUN] Would reclaim batch of ${accounts.length} accounts (~${potentialSol.toFixed(4)} SOL)`);
            return { success: accounts.length, failed: 0, sol: potentialSol };
        }

        console.log(`[KoraScan] Reclaiming batch of ${accounts.length} accounts...`);

        try {
            const tx = new Transaction();

            // Add priority fee
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
            for (const pubkeyStr of validPubkeys) {
                await updateAccountStatus(pubkeyStr, 'reclaimed', Date.now(), signature);
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
                        sol += result.lamports; // reclaimSingle now returns struct
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
            return { success: true, lamports: info.lamports / 1e9 };

        } catch (e: any) {
            console.error(`[KoraScan] Single reclaim failed for ${pubkey.toBase58()}: ${e.message}`);
            return { success: false, lamports: 0 };
        }
    }
}
