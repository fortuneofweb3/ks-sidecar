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
    timestamp: number;
    sponsorshipSource: string;
    memo: string;
}

/**
 * Global registry to prevent concurrent scans for the same operator
 */
const ACTIVE_SCANS = new Set<string>();

/**
 * Discoverer - Saves to Local SQLite, uses checkpoints for incremental scans
 */
export class Discoverer {
    connection: Connection;
    operatorAddress: PublicKey;
    heliusClient: HeliusClient;
    analyzer: Analyzer;
    private logPrefix: string;
    private cachedRent: number | null = null;

    constructor(connection: Connection, operatorAddress: PublicKey) {
        const opStr = operatorAddress.toBase58();
        this.connection = connection;
        this.operatorAddress = operatorAddress;
        this.heliusClient = new HeliusClient();
        this.analyzer = new Analyzer(connection, operatorAddress, true, this.heliusClient); // SILENT BY DEFAULT
        this.logPrefix = `[Discoverer:${opStr.slice(0, 6)}...]`;
    }

    /**
     * Main scan method - uses checkpoints for incremental updates
     * 
     * Returns cached data immediately, then updates in background
     */
    async scan(options: { waitForSync?: boolean, forceVerify?: boolean, maxScanLimit?: number } = {}): Promise<{
        fromCache: boolean;
        accounts: database.SponsoredAccount[];
        stats: Awaited<ReturnType<typeof database.getOperatorStats>>;
        checkpoint: database.ScanCheckpoint | null;
    }> {
        const operator = this.operatorAddress.toBase58();

        // Check for existing checkpoint
        let checkpoint = await database.getCheckpoint(operator);

        // If we have any data, return it immediately (unless we want to wait)
        if (checkpoint) {
            const backgroundPromise = this.updateInBackground(checkpoint, options.forceVerify, options.maxScanLimit);

            if (options.waitForSync) {
                console.log(`${this.logPrefix} Waiting for sync to complete...`);
                await backgroundPromise;
                // Refetch fresh stats after sync
                const accounts = await database.getAccountsForOperator(operator);
                const stats = await database.getOperatorStats(operator);
                return { fromCache: false, accounts, stats, checkpoint };
            }

            // Standard "return fast" behavior
            const accounts = await database.getAccountsForOperator(operator);
            const stats = await database.getOperatorStats(operator);
            return { fromCache: true, accounts, stats, checkpoint };
        }

        // First time scanning - initialize checkpoint and start scan
        if (ACTIVE_SCANS.has(operator)) {
            const accounts = await database.getAccountsForOperator(operator);
            const stats = await database.getOperatorStats(operator);
            return { fromCache: true, accounts, stats, checkpoint: null };
        }

        console.log(`${this.logPrefix} Initial scan starting...`);

        // Initialize dynamic rent calculation (Token Account = 165 bytes)
        if (!this.cachedRent) {
            try {
                this.cachedRent = await this.connection.getMinimumBalanceForRentExemption(165);
            } catch (e) {
                console.warn(`${this.logPrefix} Failed to fetch rent exemption from RPC. Using standard fallback (2039280).`);
                this.cachedRent = 2039280;
            }
        }

        // Step 1: Start historical scan (Wait if necessary)
        const scanTask = this.fullScan(options.maxScanLimit);
        if (options.waitForSync) {
            await scanTask;
        }

        checkpoint = await database.getCheckpoint(operator);
        const accounts = await database.getAccountsForOperator(operator);
        const stats = await database.getOperatorStats(operator);

        return { fromCache: false, accounts, stats, checkpoint };
    }



    /**
     * Comprehensive scan - fetches history incrementally
     */
    private async fullScan(limit: number = Infinity): Promise<void> {
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

            if (!this.cachedRent) {
                try {
                    this.cachedRent = await this.connection.getMinimumBalanceForRentExemption(165);
                } catch (e) {
                    this.cachedRent = 2039280;
                }
            }

            // Start from where we left off (oldestSignature) or the very beginning
            let before: string | undefined = checkpoint?.oldestSignature || undefined;
            let totalProcessed = 0;
            let foundAccounts: DiscoveredAccount[] = [];

            let reachedEnd = false;
            // Track boundaries
            let newestSig: string | null = checkpoint?.newestSignature || null;
            let newestSlot: number | null = checkpoint?.newestSlot || null;
            let oldestSig: string | null = checkpoint?.oldestSignature || null;
            let oldestSlot: number | null = checkpoint?.oldestSlot || null;

            while (true) {
                try {
                    // OPTIMIZATION: Use 'SET_AUTHORITY' to ignore noise (transfers/swaps/etc)
                    const txs = await this.heliusClient.getTransactionHistory(operator, {
                        limit: 100,
                        before,
                        type: 'SET_AUTHORITY'
                    });
                    if (txs.length === 0) {
                        reachedEnd = true;
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

                        // Save fee immediately (it's cheap)
                        if (tx.feePayer === operator) {
                            await database.addOperatorFee(tx.signature, operator, tx.fee, tx.timestamp, tx.type, tx.slot);
                        }
                    }

                    totalProcessed += txs.length;
                    before = txs[txs.length - 1].signature;

                    // Save batch to database
                    if (foundAccounts.length >= 50) {
                        await this.saveAccounts(foundAccounts);
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

                    if (totalProcessed >= limit) {
                        console.log(`${this.logPrefix} Hit scan limit of ${limit} transactions. Stop.`);
                        break;
                    }

                    // Continue until we get an empty array
                    await new Promise(r => setTimeout(r, 100)); // Rate limiting
                } catch (e: any) {
                    console.error(`${this.logPrefix} Error during historical scan: ${e.message}`);
                    break; // Stop and save progress
                }
            }

            // Save remaining accounts
            if (foundAccounts.length > 0) {
                await this.saveAccounts(foundAccounts);
            }

            // Final checkpoint update for this run
            const stats = await database.getOperatorStats(operator);
            await database.updateCheckpoint({
                operator,
                oldestSignature: oldestSig || undefined,
                newestSignature: newestSig || undefined,
                oldestSlot: oldestSlot || undefined,
                newestSlot: newestSlot || undefined,
                totalAccounts: stats.totalAccounts,
                reclaimableCount: stats.reclaimableAccounts,
                reclaimableLamports: stats.reclaimableLamports,
                scanStatus: 'complete',
                firstScanComplete: reachedEnd,
            });

            // Cleanup redundant check (now handled by reachedEnd above)

            console.log(`${this.logPrefix} Historical scan complete. ${stats.totalAccounts} accounts total.`);
        } catch (e: any) {
            console.error(`${this.logPrefix} Global scan error: ${e.message}`);
        } finally {
            ACTIVE_SCANS.delete(operator);
        }
    }

    /**
     * Continuous background update - fetches NEW and MISSING OLD history
     */
    private async updateInBackground(checkpoint: database.ScanCheckpoint, forceVerify = false, limit: number = Infinity): Promise<void> {
        const operator = this.operatorAddress.toBase58();
        if (ACTIVE_SCANS.has(operator)) return;
        ACTIVE_SCANS.add(operator);

        // Upwards: Fetch NEW transactions since newestSignature
        if (!this.cachedRent) {
            try {
                this.cachedRent = await this.connection.getMinimumBalanceForRentExemption(165);
            } catch (e) {
                this.cachedRent = 2039280;
            }
        }

        try {
            let before: string | undefined;
            let foundNew: DiscoveredAccount[] = [];
            let newNewestSig = checkpoint.newestSignature;
            let newNewestSlot = checkpoint.newestSlot;

            while (true) {
                const txs = await this.heliusClient.getTransactionHistory(operator, {
                    limit: 100,
                    before,
                    type: 'SET_AUTHORITY' // Kora often uses SET_AUTHORITY for sponsorship
                });
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

                    if (tx.feePayer === operator) {
                        await database.addOperatorFee(tx.signature, operator, tx.fee, tx.timestamp, tx.type, tx.slot);
                    }
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

        // 2. ONLY re-verify active accounts if they haven't been checked in the last hour OR if forced
        const ONE_HOUR = 3600000;
        const lastFullCheck = checkpoint.lastScanAt || 0;
        const isStale = forceVerify || (Date.now() - lastFullCheck) > ONE_HOUR;

        if (isStale) {
            console.log(`${this.logPrefix} Stale data detected. Refreshing active accounts...`);
            let batchesProcessed = 0;
            let totalUpdated = 0;

            // Limitless refresh (loop until exhausted)
            while (true) {
                const { hasMore, updated } = await this.refreshActiveAccounts(1000, true);
                batchesProcessed++;
                totalUpdated += updated;
                if (!hasMore) break;
                if (batchesProcessed > 100) break; // Safety cap 100k
                await new Promise(r => setTimeout(r, 200));
            }
            if (totalUpdated > 0) {
                console.log(`${this.logPrefix} Sync complete: Found ${totalUpdated} new reclaimable accounts.`);
            }
        }

        // 3. Downwards: If firstScanComplete is false, continue fetching old history
        if (!checkpoint.firstScanComplete) {
            await this.fullScan(limit).catch(e => console.error(`${this.logPrefix} Continued fullScan failed: ${e.message}`));
        }

        ACTIVE_SCANS.delete(operator);
    }

    /**
     * Verify status of existing 'active' accounts
     */
    private async refreshActiveAccounts(forceCount?: number, silent = false): Promise<{ hasMore: boolean, updated: number }> {
        const operator = this.operatorAddress.toBase58();
        const limit = forceCount || 500;
        const active = await database.getActiveAccountsForOperator(operator, limit);

        if (active.length === 0) return { hasMore: false, updated: 0 };

        if (!silent) console.log(`[Scanner] Re-verifying ${active.length} active accounts...`);

        const results = await this.analyzer.analyzeAccounts(active.map(a => ({
            pubkey: a.pubkey,
            userWallet: a.userWallet,
            mint: a.mint,
            type: a.type as any,
            rentPaid: a.rentPaid,
            signature: a.signature,
            slot: a.slot,
            timestamp: 0,
            sponsorshipSource: 'UNKNOWN',
            memo: ''
        })));

        const updates: {
            pubkey: string,
            mint: string,
            userWallet: string,
            status?: string,
            reclaimedAt?: number,
            reclaimSignature?: string
        }[] = [];

        for (const res of results) {
            let status: string | undefined;

            if (res.status === 'closed') {
                status = 'closed';
            } else if (res.canReclaim) {
                status = 'reclaimable';
            } else if (res.reason === 'authority_mismatch') {
                status = 'locked';
            }

            if (status) {
                const update: any = {
                    pubkey: res.pubkey,
                    mint: res.mint,
                    userWallet: res.userWallet,
                    status
                };

                if (status === 'closed') {
                    try {
                        const history = await this.heliusClient.getTransactionHistory(res.pubkey, { limit: 1 });
                        if (history.length > 0) {
                            const last = history[0];
                            update.reclaimedAt = (last.timestamp || 0) * 1000;
                            update.reclaimSignature = last.signature;
                        }
                    } catch { }
                }
                updates.push(update);
            }
        }

        if (updates.length > 0) {
            await database.batchUpdateAccountMetadata(updates);
        }

        return { hasMore: active.length === limit, updated: updates.length };
    }

    private processTransaction(tx: HeliusTransaction): DiscoveredAccount[] {
        const operatorStr = this.operatorAddress.toBase58();
        const found: DiscoveredAccount[] = [];

        if (tx.feePayer !== operatorStr) {
            return found;
        }

        // Only process transactions that actually created accounts or set authorities
        if (tx.type !== 'CREATE_ACCOUNT' && tx.type !== 'SET_AUTHORITY' && tx.type !== 'UNKNOWN') {
            return found;
        }

        for (const accData of tx.accountData || []) {
            const acc = accData.account;
            const balanceChange = accData.nativeBalanceChange;

            // DYNAMIC RENT CHECK (NO GUESSSWORK)
            const rent = this.cachedRent || 2039280; // Fallback to classic rent if not cached
            const isRentMatch = Math.abs(balanceChange - rent) < 100;
            if (!isRentMatch) continue;

            if (acc === operatorStr || SYSTEM_ADDRESSES.has(acc)) continue;

            console.log(`${this.logPrefix} Potential Kora account detected: ${acc.slice(0, 8)} in tx ${tx.signature.slice(0, 8)}`);

            let type: 'token' | 'token-2022' | 'system' = 'system';
            let userWallet = '';
            let mint = '';

            for (const ix of tx.instructions || []) {
                // Check multiple creation patterns (Classic ATA and generic InitializeAccount)
                if ((ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID || ix.programId === TOKEN_PROGRAM_ID || ix.programId === TOKEN_2022_PROGRAM_ID)) {
                    const accounts = ix.accounts || [];
                    // Pattern for CreateAssociatedTokenAccount: [payer, ata, owner, mint, system, token...]
                    if (ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID && accounts.length >= 4 && accounts[1] === acc) {
                        userWallet = accounts[2];
                        mint = accounts[3];
                        type = (accounts[5] === TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'token';
                        break;
                    }
                    // Generic pattern might still be here, but SET_AUTHORITY transactions 
                    // usually have the account in the instructions list if they are relevant.
                }
            }

            if (!userWallet) {
                // If we didn't find the ATA instruction, look for the most likely owner (the only other non-system account)
                const candidate = tx.accountData?.find(a =>
                    a.account !== operatorStr &&
                    a.account !== acc &&
                    !SYSTEM_ADDRESSES.has(a.account)
                );
                if (candidate) userWallet = candidate.account;
            }

            if (type === 'token' || type === 'token-2022') {
                found.push({
                    pubkey: acc,
                    userWallet,
                    mint,
                    type,
                    rentPaid: balanceChange,
                    signature: tx.signature,
                    slot: tx.slot,
                    timestamp: tx.timestamp,
                    sponsorshipSource: tx.source || 'UNKNOWN',
                    memo: ''
                });
            }
        }

        return found;
    }

    private async saveAccounts(accounts: DiscoveredAccount[]): Promise<void> {
        if (accounts.length === 0) return;
        const operator = this.operatorAddress.toBase58();

        const analyzed = await this.analyzer.analyzeAccounts(accounts);
        const verified = analyzed.filter(a => a.canReclaim || a.reason === 'authority_mismatch');

        if (verified.length === 0) return;

        console.log(`${this.logPrefix} Verified ${verified.length}/${accounts.length} potential accounts.`);

        const toSave: database.SponsoredAccount[] = verified.map(a => {
            const original = accounts.find(o => o.pubkey === a.pubkey);
            return {
                pubkey: a.pubkey,
                operator,
                userWallet: a.userWallet,
                mint: a.mint,
                type: a.type as any,
                rentPaid: a.lamports,
                signature: original?.signature || 'UNKNOWN',
                slot: original?.slot || 0,
                initialTimestamp: original?.timestamp || Date.now(),
                sponsorshipSource: original?.sponsorshipSource || 'UNKNOWN',
                memo: original?.memo || '',
                status: a.canReclaim ? 'reclaimable' : 'locked',
            };
        });

        await database.batchUpsertAccounts(toSave);
    }
}
