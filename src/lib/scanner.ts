import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { HeliusClient, HeliusTransaction } from './helius';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbAtYpYbt9UEHJR9YWYvNf2t8S77tB39L';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const TOKEN_ACCOUNT_RENT = 2039280;

const SYSTEM_ADDRESSES = new Set([
    'SysvarRent111111111111111111111111111111111',
    'SysvarC1ock11111111111111111111111111111111',
    'SysvarRecentB1ockHashes11111111111111111111',
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    'ComputeBudget111111111111111111111111111111',
]);

export interface DiscoveredAccount {
    pubkey: string;
    userWallet: string;  // The ACTUAL owner of the account (not operator)
    mint: string;
    type: 'token' | 'token-2022' | 'system';
    rentPaid: number;
    signature: string;
    slot: number;
}

/**
 * KoraScan Scanner
 * 
 * Finds sponsored accounts - token accounts where:
 * - Operator paid the rent (was fee payer)
 * - Account is OWNED by another user (not operator)
 * - Operator may have close authority to reclaim rent
 */
export class Scanner {
    connection: Connection;
    operatorAddress: PublicKey;
    heliusClient: HeliusClient | null;
    useHelius: boolean;
    discoveredAccounts: DiscoveredAccount[] = [];

    constructor(connection: Connection, operatorAddress: PublicKey, useHelius: boolean = true) {
        this.connection = connection;
        this.operatorAddress = operatorAddress;
        this.useHelius = useHelius && !!process.env.HELIUS_API_KEY;
        this.heliusClient = this.useHelius ? new HeliusClient() : null;

        const mode = this.useHelius ? 'Helius (Fast)' : 'RPC (Standard)';
        console.log(`[KoraScan] Scanner initialized for operator: ${operatorAddress.toBase58()} | Mode: ${mode}`);
    }

    async scanTransactionHistory(limit?: number): Promise<DiscoveredAccount[]> {
        this.discoveredAccounts = [];

        if (this.useHelius && this.heliusClient) {
            await this.scanWithHeliusParallel(limit);
        } else {
            await this.scanWithRPC(limit || 1000);
        }

        return this.discoveredAccounts;
    }

    /**
     * Fast Helius scan - uses getTransactionHistory which returns ALREADY PARSED data
     */
    async scanWithHeliusParallel(limit?: number): Promise<number> {
        console.log(`[KoraScan] Helius scan (limit: ${limit || 'ALL'})...`);

        let before: string | undefined;
        let totalProcessed = 0;
        const maxTxs = limit || 100000;
        let retries = 0;

        while (totalProcessed < maxTxs) {
            try {
                const txs = await this.heliusClient!.getTransactionHistory(
                    this.operatorAddress.toBase58(),
                    { limit: 100, before }
                );

                if (txs.length === 0) break;

                for (const tx of txs) {
                    const accounts = this.processHeliusTransaction(tx);
                    this.discoveredAccounts.push(...accounts);
                }

                totalProcessed += txs.length;
                before = txs[txs.length - 1].signature;
                retries = 0; // Reset retries on success

                if (totalProcessed % 500 === 0 || txs.length < 100) {
                    console.log(`  Processed ${totalProcessed} txs, found ${this.discoveredAccounts.length} sponsored accounts`);
                }

                if (txs.length < 100) break;
                await new Promise(r => setTimeout(r, 50)); // Small delay
            } catch (e: any) {
                retries++;
                if (retries > 3) {
                    console.error(`  [Helius] Max retries reached: ${e.message}`);
                    break;
                }
                console.log(`  [Helius] Retry ${retries}/3...`);
                await new Promise(r => setTimeout(r, 1000 * retries));
            }
        }

        console.log(`[KoraScan] Scan complete. Found: ${this.discoveredAccounts.length} sponsored accounts across ${totalProcessed} txs.`);
        return this.discoveredAccounts.length;
    }

    /**
     * Process Helius transaction to find sponsored account creations.
     */
    private processHeliusTransaction(tx: HeliusTransaction): DiscoveredAccount[] {
        const operatorStr = this.operatorAddress.toBase58();
        const found: DiscoveredAccount[] = [];

        // Only process if operator was the fee payer
        if (tx.feePayer !== operatorStr) return found;

        // Look at accountData for accounts that received rent-sized deposits
        for (const accData of tx.accountData || []) {
            const acc = accData.account;
            const balanceChange = accData.nativeBalanceChange;

            // Rent-sized deposit: 1M - 3M lamports
            if (balanceChange < 1000000 || balanceChange > 3000000) continue;

            // Skip operator itself and system addresses
            if (acc === operatorStr) continue;
            if (SYSTEM_ADDRESSES.has(acc)) continue;

            // Determine account type and user wallet
            let type: 'token' | 'token-2022' | 'system' = 'system';
            let userWallet = '';
            let mint = '';

            // Check instructions to determine account type
            for (const ix of tx.instructions || []) {
                if (ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
                    const accounts = ix.accounts || [];
                    if (accounts.length >= 4 && accounts[1] === acc) {
                        userWallet = accounts[2]; // The user who OWNS this ATA
                        mint = accounts[3];
                        type = (accounts[5] === TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'token';
                        break;
                    }
                }

                // Check inner instructions
                for (const inner of ix.innerInstructions || []) {
                    if (inner.programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
                        const accounts = inner.accounts || [];
                        if (accounts.length >= 4 && accounts[1] === acc) {
                            userWallet = accounts[2];
                            mint = accounts[3];
                            type = (accounts[5] === TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'token';
                            break;
                        }
                    }
                }

                if (ix.programId === TOKEN_PROGRAM_ID || ix.programId === TOKEN_2022_PROGRAM_ID) {
                    const accounts = ix.accounts || [];
                    if (accounts.includes(acc)) {
                        type = ix.programId === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'token';
                        const potentialOwner = accounts.find(a =>
                            a !== acc && !SYSTEM_ADDRESSES.has(a) && a !== operatorStr
                        );
                        if (potentialOwner) userWallet = potentialOwner;
                    }
                }
            }

            // If we couldn't identify user, try other accounts in tx
            if (!userWallet) {
                const otherAccounts = (tx.accountData || [])
                    .map(a => a.account)
                    .filter(a => a !== operatorStr && a !== acc && !SYSTEM_ADDRESSES.has(a));
                if (otherAccounts.length > 0) userWallet = otherAccounts[0];
            }

            found.push({
                pubkey: acc,
                userWallet, // This is the USER who owns the account, NOT operator
                mint,
                type,
                rentPaid: balanceChange,
                signature: tx.signature,
                slot: tx.slot
            });
        }

        return found;
    }

    async scanWithRPC(limit: number = 1000): Promise<number> {
        console.log(`[KoraScan] RPC scan (limit: ${limit})...`);

        let allSignatures: string[] = [];
        let lastSignature: string | undefined;

        while (allSignatures.length < limit) {
            const fetchLimit = Math.min(limit - allSignatures.length, 1000);
            const sigs = await this.connection.getSignaturesForAddress(
                this.operatorAddress,
                { limit: fetchLimit, before: lastSignature }
            );
            if (sigs.length === 0) break;
            allSignatures.push(...sigs.map(s => s.signature));
            lastSignature = sigs[sigs.length - 1].signature;
            console.log(`  Fetched ${allSignatures.length} signatures...`);
        }

        const BATCH_SIZE = 25;
        for (let i = 0; i < allSignatures.length; i += BATCH_SIZE) {
            const batch = allSignatures.slice(i, i + BATCH_SIZE);
            try {
                const txs = await this.connection.getParsedTransactions(batch, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });
                for (let j = 0; j < txs.length; j++) {
                    const tx = txs[j];
                    if (!tx) continue;
                    const found = this.processRPCTransaction(tx, batch[j], tx.slot || 0);
                    this.discoveredAccounts.push(...found);
                }
                await new Promise(r => setTimeout(r, 50));
            } catch (e) {
                console.error(`[KoraScan] Batch ${i} failed`);
            }
        }

        console.log(`[KoraScan] RPC scan complete. Found: ${this.discoveredAccounts.length}`);
        return this.discoveredAccounts.length;
    }

    private processRPCTransaction(tx: ParsedTransactionWithMeta, signature: string, slot: number): DiscoveredAccount[] {
        if (!tx.meta) return [];
        const operatorStr = this.operatorAddress.toBase58();
        const keys = tx.transaction.message.accountKeys;
        if (keys[0].pubkey.toBase58() !== operatorStr) return [];

        const found: DiscoveredAccount[] = [];
        const preBalances = tx.meta.preBalances || [];
        const postBalances = tx.meta.postBalances || [];

        for (let i = 0; i < keys.length; i++) {
            const acc = keys[i].pubkey.toBase58();
            const change = (postBalances[i] || 0) - (preBalances[i] || 0);

            if (change < 1000000 || change > 3000000) continue;
            if (acc === operatorStr || SYSTEM_ADDRESSES.has(acc)) continue;

            let userWallet = '';
            let mint = '';
            let type: 'token' | 'token-2022' | 'system' = 'system';

            const tokenBalance = (tx.meta.postTokenBalances || []).find(
                tb => keys[tb.accountIndex]?.pubkey.toBase58() === acc
            );
            if (tokenBalance) {
                type = 'token';
                userWallet = tokenBalance.owner || '';
                mint = tokenBalance.mint || '';
            }

            found.push({ pubkey: acc, userWallet, mint, type, rentPaid: change, signature, slot });
        }

        return found;
    }
}
