import { Connection, PublicKey } from '@solana/web3.js';
import { HeliusClient, HeliusTransaction } from './helius';
import * as database from './database';
import { Analyzer } from './analyzer';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbAtYpYbt9UEHJR9YWYvNf2t8S77tB39L';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const SYSTEM_ADDRESSES = new Set([
    'SysvarRent111111111111111111111111111111111',
    'SysvarC1ock11111111111111111111111111111111',
    SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID, 'ComputeBudget111111111111111111111111111111',
]);

export interface DiscoveredAccount {
    pubkey: string;
    userWallet: string;
    mint: string;
    type: 'token' | 'token-2022' | 'system';
    rentPaid: number;
    signature: string;
    slot: number;
}

/**
 * Global registry to prevent concurrent scans for the same operator
 */
const ACTIVE_SCANS = new Set<string>();

/**
 * IncrementalScanner - Saves to Turso, uses checkpoints for incremental scans
 */
export class IncrementalScanner {
    connection: Connection;
    operatorAddress: PublicKey;
    heliusClient: HeliusClient;
    analyzer: Analyzer;
    private logPrefix: string;

    constructor(connection: Connection, operatorAddress: PublicKey) {
        const opStr = operatorAddress.toBase58();
        this.connection = connection;
        this.operatorAddress = operatorAddress;
        this.heliusClient = new HeliusClient();
        this.analyzer = new Analyzer(connection, operatorAddress, true, this.heliusClient); // SILENT BY DEFAULT
        this.logPrefix = `[Scanner:${opStr.slice(0, 6)}...]`;
    }

    /**
     * Main scan method - uses checkpoints for incremental updates
     * 
     * Returns cached data immediately, then updates in background
     */
    async scan(): Promise<{
        fromCache: boolean;
        accounts: database.SponsoredAccount[];
        stats: Awaited<ReturnType<typeof database.getOperatorStats>>;
        checkpoint: database.ScanCheckpoint | null;
    }> {
        const operator = this.operatorAddress.toBase58();

        // Check for existing checkpoint
        let checkpoint = await database.getCheckpoint(operator);

        // If we have any data, return it immediately and update in background
        if (checkpoint) {
            const accounts = await database.getAccountsForOperator(operator);
            const stats = await database.getOperatorStats(operator);

            // Trigger background update (upwards, downwards, AND status checks)
            this.updateInBackground(checkpoint);

            return { fromCache: true, accounts, stats, checkpoint };
        }

        // First time scanning - initialize checkpoint and start scan
        if (ACTIVE_SCANS.has(operator)) {
            const accounts = await database.getAccountsForOperator(operator);
            const stats = await database.getOperatorStats(operator);
            return { fromCache: true, accounts, stats, checkpoint: null };
        }

        console.log(`${this.logPrefix} Initial scan starting...`);

        // Step 1: Fast scan skipped (Fragile RPC calls)
        // await this.fastStatusCheck(true);

        // Step 2: Start historical scan in background
        this.fullScan();

        checkpoint = await database.getCheckpoint(operator);
        const accounts = await database.getAccountsForOperator(operator);
        const stats = await database.getOperatorStats(operator);

        return { fromCache: false, accounts, stats, checkpoint };
    }

    /**
     * Comprehensive scan - fetches history incrementally
     */
    private async fullScan(): Promise<void> {
        const operator = this.operatorAddress.toBase58();
        let checkpoint = await database.getCheckpoint(operator);

        // If we already finished the deep scan, just do an update
        if (checkpoint?.firstScanComplete) {
            return;
        }

        if (ACTIVE_SCANS.has(operator)) return;
        ACTIVE_SCANS.add(operator);

        try {
            await database.updateCheckpoint({
                operator,
                scanStatus: 'scanning',
                firstScanComplete: false,
            });

            console.log(`${this.logPrefix} Fetching historical data...`);

            // Start from where we left off (oldestSignature) or the very beginning
            let before: string | undefined = checkpoint?.oldestSignature || undefined;
            let totalProcessed = 0;
            let foundAccounts: DiscoveredAccount[] = [];

            // Track boundaries
            let newestSig: string | null = checkpoint?.newestSignature || null;
            let newestSlot: number | null = checkpoint?.newestSlot || null;
            let oldestSig: string | null = checkpoint?.oldestSignature || null;
            let oldestSlot: number | null = checkpoint?.oldestSlot || null;

            while (true) {
                try {
                    const txs = await this.heliusClient.getTransactionHistory(operator, { limit: 100, before });
                    if (txs.length === 0) {
                        console.log(`${this.logPrefix} No historical transactions found for this address on Helius.`);
                        break;
                    }

                    // Track newest boundaries (only on the very first batch ever)
                    if (!newestSig) {
                        newestSig = txs[0].signature;
                        newestSlot = txs[0].slot;
                    }

                    // Track oldest boundaries
                    oldestSig = txs[txs.length - 1].signature;
                    oldestSlot = txs[txs.length - 1].slot;

                    // Process transactions
                    for (const tx of txs) {
                        const accounts = this.processTransaction(tx);
                        foundAccounts.push(...accounts);
                    }

                    totalProcessed += txs.length;
                    before = txs[txs.length - 1].signature;

                    // Save batch to database
                    if (foundAccounts.length >= 50) {
                        await this.saveAccounts(foundAccounts);

                        // Periodically verify some accounts during the scan
                        await this.refreshActiveAccounts();

                        foundAccounts = [];

                        // Periodically update checkpoint during long scans
                        await database.updateCheckpoint({
                            operator,
                            oldestSignature: oldestSig,
                            oldestSlot,
                            newestSignature: newestSig,
                            newestSlot,
                            scanStatus: 'scanning'
                        });
                    }

                    if (totalProcessed % 500 === 0) {
                        console.log(`${this.logPrefix} Processed ${totalProcessed} txs downwards...`);
                    }

                    if (txs.length < 100) break;
                    await new Promise(r => setTimeout(r, 100)); // Rate limiting
                } catch (e: any) {
                    console.error(`${this.logPrefix} Error during historical scan: ${e.message}`);
                    break; // Stop and save progress
                }
            }

            ACTIVE_SCANS.delete(operator);

            // Save remaining accounts
            if (foundAccounts.length > 0) {
                await this.saveAccounts(foundAccounts);
            }

            // Final checkpoint update for this run
            const stats = await database.getOperatorStats(operator);
            await database.updateCheckpoint({
                operator,
                oldestSignature: oldestSig,
                newestSignature: newestSig,
                oldestSlot,
                newestSlot,
                totalAccounts: stats.totalAccounts,
                reclaimableCount: stats.reclaimableAccounts,
                reclaimableLamports: stats.reclaimableLamports,
                scanStatus: 'complete',
                firstScanComplete: before === undefined || totalProcessed === 0 || (totalProcessed % 100 !== 0), // Heuristic
            });

            // If we hit the end of history, mark as complete
            if (totalProcessed < 100 && totalProcessed > 0) {
                await database.updateCheckpoint({ operator, firstScanComplete: true });
            }

            console.log(`${this.logPrefix} Historical scan slice complete. ${stats.totalAccounts} accounts total.`);
        } catch (e: any) {
            console.error(`${this.logPrefix} Global scan error: ${e.message}`);
        } finally {
            ACTIVE_SCANS.delete(operator);
        }
    }

    /**
     * Continuous background update - fetches NEW and MISSING OLD history
     */
    private async updateInBackground(checkpoint: database.ScanCheckpoint): Promise<void> {
        const operator = this.operatorAddress.toBase58();
        if (ACTIVE_SCANS.has(operator)) return;
        ACTIVE_SCANS.add(operator);

        // 1. Upwards: Fetch NEW transactions since newestSignature
        try {
            let before: string | undefined;
            let foundNew: DiscoveredAccount[] = [];
            let newNewestSig = checkpoint.newestSignature;
            let newNewestSlot = checkpoint.newestSlot;

            while (true) {
                const txs = await this.heliusClient.getTransactionHistory(operator, { limit: 100, before });
                if (txs.length === 0) break;

                // Stop if we hit our newest known signature
                const hitCheckpoint = txs.findIndex(t => t.signature === checkpoint.newestSignature);
                const relevantTxs = hitCheckpoint >= 0 ? txs.slice(0, hitCheckpoint) : txs;

                if (relevantTxs.length === 0) break;

                if (!before) {
                    newNewestSig = relevantTxs[0].signature;
                    newNewestSlot = relevantTxs[0].slot;
                }

                for (const tx of relevantTxs) {
                    const accounts = this.processTransaction(tx);
                    foundNew.push(...accounts);
                }

                if (hitCheckpoint >= 0) break;
                before = txs[txs.length - 1].signature;
                await new Promise(r => setTimeout(r, 100));
            }

            if (foundNew.length > 0) {
                await this.saveAccounts(foundNew);
                console.log(`[Scanner] Found ${foundNew.length} new transactions for ${operator.slice(0, 8)}`);
            }

            await database.updateCheckpoint({
                operator,
                newestSignature: newNewestSig,
                newestSlot: newNewestSlot,
                lastScanAt: Date.now()
            });
        } catch (e: any) {
            console.error(`[Scanner] Upwards update failed: ${e.message}`);
        }

        // 2. Status check: Refresh active accounts aggressively
        // await this.fastStatusCheck(); // REMOVED: Fragile RPC call

        // ONLY re-verify active accounts if they haven't been checked in the last hour
        // This prevents "Rows Read" from exploding during the 5-minute dashboard refreshes
        const ONE_HOUR = 3600000;
        const lastFullCheck = checkpoint.lastScanAt || 0;
        const isStale = (Date.now() - lastFullCheck) > ONE_HOUR;

        if (isStale) {
            console.log(`${this.logPrefix} Stale data detected. Refreshing up to 2,500 active accounts...`);
            let batchesProcessed = 0;
            let totalUpdated = 0;
            for (let i = 0; i < 5; i++) {
                const { hasMore, updated } = await this.refreshActiveAccounts(500, true);
                batchesProcessed++;
                totalUpdated += updated;
                if (!hasMore) break;
                await new Promise(r => setTimeout(r, 200));
            }
            if (totalUpdated > 0) {
                console.log(`${this.logPrefix} Sync complete: Found ${totalUpdated} new reclaimable accounts.`);
            }
        }

        // 3. Downwards: If firstScanComplete is false, continue fetching old history
        if (!checkpoint.firstScanComplete) {
            await this.fullScan().catch(e => console.error(`${this.logPrefix} Continued fullScan failed: ${e.message}`));
        }

        ACTIVE_SCANS.delete(operator);
    }



    /**
     * Verify status of existing 'active' accounts
     */
    private async refreshActiveAccounts(forceCount?: number, silent = false): Promise<{ hasMore: boolean, updated: number }> {
        const operator = this.operatorAddress.toBase58();
        const limit = forceCount || 500; // Increased batch size
        const active = await database.getActiveAccountsForOperator(operator, limit);

        if (active.length === 0) return { hasMore: false, updated: 0 };

        if (!silent) console.log(`[Scanner] Re-verifying ${active.length} active accounts (Scaling batch)...`);

        const results = await this.analyzer.analyzeAccounts(active.map(a => ({
            pubkey: a.pubkey,
            userWallet: a.userWallet,
            mint: a.mint,
            type: a.type as any,
            rentPaid: a.rentPaid,
            signature: a.signature,
            slot: a.slot
        })));

        const updates: { pubkey: string, status: string }[] = [];
        for (const res of results) {
            if (res.status === 'closed') {
                updates.push({ pubkey: res.pubkey, status: 'closed' });
            } else if (res.canReclaim) {
                updates.push({ pubkey: res.pubkey, status: 'reclaimable' });
            } else if (res.lamports > 0 && res.reason?.includes('balance')) {
                // Still has balance, keep as active
            } else if (res.reason?.includes('authority')) {
                // Zero balance but no authority
                updates.push({ pubkey: res.pubkey, status: 'locked' });
            }
        }

        if (updates.length > 0) {
            await database.batchUpdateAccountStatuses(updates);
            if (!silent) console.log(`[Scanner] Updated ${updates.length} accounts to 'reclaimable' status.`);
        }

        return { hasMore: active.length === limit, updated: updates.length };
    }

    private processTransaction(tx: HeliusTransaction): DiscoveredAccount[] {
        const operatorStr = this.operatorAddress.toBase58();
        const found: DiscoveredAccount[] = [];

        if (tx.feePayer !== operatorStr) {
            // If the user scanned a Program ID, it will never be the fee payer
            return found;
        }

        for (const accData of tx.accountData || []) {
            const acc = accData.account;
            const balanceChange = accData.nativeBalanceChange;

            if (balanceChange < 1000000 || balanceChange > 3000000) continue;
            if (acc === operatorStr || SYSTEM_ADDRESSES.has(acc)) continue;

            let type: 'token' | 'token-2022' | 'system' = 'system';
            let userWallet = '';
            let mint = '';

            for (const ix of tx.instructions || []) {
                if (ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
                    const accounts = ix.accounts || [];
                    if (accounts.length >= 4 && accounts[1] === acc) {
                        userWallet = accounts[2];
                        mint = accounts[3];
                        type = (accounts[5] === TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'token';
                        break;
                    }
                }
            }

            if (!userWallet) {
                const others = (tx.accountData || []).map(a => a.account).filter(a => a !== operatorStr && a !== acc && !SYSTEM_ADDRESSES.has(a));
                if (others.length > 0) userWallet = others[0];
            }

            // ONLY track token accounts for rent reclamation to save storage and rows
            if (type === 'token' || type === 'token-2022') {
                found.push({ pubkey: acc, userWallet, mint, type, rentPaid: balanceChange, signature: tx.signature, slot: tx.slot });
            }
        }

        return found;
    }

    private async saveAccounts(accounts: DiscoveredAccount[]): Promise<void> {
        const operator = this.operatorAddress.toBase58();
        const toSave: database.SponsoredAccount[] = accounts.map(a => ({
            ...a,
            operator,
            status: 'active',
        }));
        await database.batchUpsertAccounts(toSave);
        // Removed redundant refreshActiveAccounts() call here to save massively on Rows Read
    }
}
