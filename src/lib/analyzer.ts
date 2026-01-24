import { Connection, PublicKey, GetProgramAccountsFilter } from '@solana/web3.js';
import { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { DiscoveredAccount } from './scanner';
import { HeliusClient } from './helius';

const TOKEN_PROGRAM_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_STR = 'TokenzQdBNbAtYpYbt9UEHJR9YWYvNf2t8S77tB39L';

export interface ReclaimableAccount {
    pubkey: string;
    userWallet: string;
    type: 'token' | 'token-2022' | 'system';
    lamports: number;
    canReclaim: boolean;
    status?: 'active' | 'reclaimable' | 'closed' | 'locked';
    reason?: string;
}

/**
 * KoraScan Analyzer
 * 
 * TWO METHODS:
 * 1. analyzeAccounts() - Check list of discovered accounts
 * 2. findReclaimableAccountsDirect() - Find ALL accounts where operator has close authority (FAST!)
 */
export class Analyzer {
    connection: Connection;
    operatorAddress: PublicKey;
    silent: boolean;
    heliusClient: HeliusClient | null;

    constructor(connection: Connection, operatorAddress: PublicKey, silent = false, heliusClient: HeliusClient | null = null) {
        this.connection = connection;
        this.operatorAddress = operatorAddress;
        this.silent = silent;
        this.heliusClient = heliusClient;
    }

    /**
     * FAST: Find ALL token accounts where operator has close authority
     * Uses getProgramAccounts with memcmp filter - finds current state, no history needed!
     */
    async findReclaimableAccountsDirect(): Promise<ReclaimableAccount[]> {
        if (!this.silent) console.log(`[KoraScan] Fast scan: Finding all accounts with operator as close authority...`);

        if (this.heliusClient) {
            return this.findReclaimableAccountsHelius();
        }

        const operatorBytes = this.operatorAddress.toBase58();
        const reclaimable: ReclaimableAccount[] = [];

        // Token account layout: closeAuthority is at offset 93 (32 bytes) when closeAuthorityOption = 1
        // But we need to check closeAuthorityOption (offset 92) = 1 first
        // This is tricky with memcmp, so we fetch more and filter locally

        for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
            try {
                const accounts = await this.connection.getProgramAccounts(programId, {
                    filters: [
                        { dataSize: 165 }, // Standard token account size
                        {
                            memcmp: {
                                offset: 133, // closeAuthority starts at 133 (after 4-byte option)
                                bytes: operatorBytes
                            }
                        }
                    ],
                    encoding: 'base64',
                });

                if (!this.silent) console.log(`  Checking ${accounts.length} ${programId === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : 'Token'} accounts...`);

                for (const { pubkey, account } of accounts) {
                    try {
                        const data = AccountLayout.decode(account.data);

                        // Check if close authority is set and matches operator
                        const hasCloseAuthority = data.closeAuthorityOption === 1;
                        const closeAuth = hasCloseAuthority ? data.closeAuthority.toBase58() : data.owner.toBase58();

                        if (closeAuth !== operatorBytes) continue;

                        // Check if zero balance
                        const isZeroBalance = data.amount === 0n;

                        if (isZeroBalance) {
                            reclaimable.push({
                                pubkey: pubkey.toBase58(),
                                userWallet: data.owner.toBase58(),
                                type: programId === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'token',
                                lamports: account.lamports,
                                canReclaim: true,
                            });
                        }
                    } catch {
                        // Invalid account data, skip
                    }
                }
            } catch (e: any) {
                console.error(`  Error scanning ${programId === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : 'Token'}: ${e.message}`);
            }
        }

        if (!this.silent) console.log(`[KoraScan] Fast scan complete. Found ${reclaimable.length} reclaimable accounts.`);
        return reclaimable;
    }

    /**
     * Helius-Specific Paginated Scan (V2)
     */
    private async findReclaimableAccountsHelius(): Promise<ReclaimableAccount[]> {
        const operatorStr = this.operatorAddress.toBase58();
        const reclaimable: ReclaimableAccount[] = [];

        const programs = [
            { id: TOKEN_PROGRAM_STR, type: 'token' },
            { id: TOKEN_2022_PROGRAM_STR, type: 'token-2022' }
        ];

        for (const { id, type } of programs) {
            let cursor: string | undefined;
            while (true) {
                try {
                    if (!this.silent) console.log(`  [Helius Direct] querying ${id} with memcmp: offset=133, bytes=${operatorStr.slice(0, 8)}...`);
                    const result = await this.heliusClient!.getProgramAccountsV2(id, {
                        cursor,
                        filters: [
                            { dataSize: 165 },
                            {
                                memcmp: {
                                    offset: 133,
                                    bytes: operatorStr
                                }
                            }
                        ]
                    });

                    // HYPER ROBUST MAPPING: Catch all variations of the results field
                    let accountsBatch: any[] = [];
                    if (Array.isArray(result)) {
                        accountsBatch = result;
                    } else if (result && typeof result === 'object') {
                        if (result.error) {
                            console.error(`  [Helius V2] API error:`, result.error);
                            break;
                        }

                        // Check common field names
                        const possibleFields = ['results', 'accounts', 'result', 'data'];
                        for (const field of possibleFields) {
                            if (Array.isArray(result[field])) {
                                accountsBatch = result[field];
                                break;
                            }
                        }

                        // If still not an array, check if it's nested (e.g. result.result.results)
                        if (accountsBatch.length === 0 && result.result && typeof result.result === 'object') {
                            for (const field of possibleFields) {
                                if (Array.isArray(result.result[field])) {
                                    accountsBatch = result.result[field];
                                    break;
                                }
                            }
                        }
                    }

                    if (!Array.isArray(accountsBatch)) {
                        console.error(`  [Helius V2] FAILED to find array in response for ${type}. Keys: ${Object.keys(result || {}).join(',')}`);
                        // Last ditch: if it's a single object, wrap it
                        if (result && result.pubkey && result.account) {
                            accountsBatch = [result];
                        } else {
                            break;
                        }
                    }

                    for (const acc of accountsBatch) {
                        try {
                            const data = AccountLayout.decode(Buffer.from(acc.account.data, 'base64'));
                            const matchesAuthority = data.closeAuthorityOption === 1 && data.closeAuthority.toBase58() === operatorStr;

                            if (matchesAuthority) {
                                if (data.amount === 0n) {
                                    reclaimable.push({
                                        pubkey: acc.pubkey,
                                        userWallet: data.owner.toBase58(),
                                        type: type as any,
                                        lamports: acc.account.lamports,
                                        canReclaim: true
                                    });
                                } else {
                                    if (!this.silent) console.log(`  [Debug] Found candidate ${acc.pubkey} but balance > 0 (${data.amount.toString()})`);
                                }
                            }
                        } catch { }
                    }

                    const nextCursor = result.cursor || result.paginationKey;
                    if (!nextCursor) break;
                    cursor = nextCursor;
                } catch (e: any) {
                    console.error(`  [Helius V2] Paginated chunk failed for ${type}: ${e.message}`);
                    break;
                }
            }
        }

        if (!this.silent) console.log(`[KoraScan] Helius V2 scan complete. Found ${reclaimable.length} reclaimable accounts.`);
        return reclaimable;
    }

    /**
     * Analyze discovered accounts to find reclaimable ones
     * Takes the output from Scanner.scanTransactionHistory() directly
     */
    async analyzeAccounts(discoveredAccounts: DiscoveredAccount[]): Promise<ReclaimableAccount[]> {
        if (!this.silent) console.log(`[KoraScan] Analyzing ${discoveredAccounts.length} discovered accounts...`);

        if (discoveredAccounts.length === 0) {
            if (!this.silent) console.log(`[KoraScan] No accounts to analyze.`);
            return [];
        }

        const reclaimable: ReclaimableAccount[] = [];
        const BATCH_SIZE = 100;
        let checked = 0;
        let closed = 0;

        // Batch fetch account info
        for (let i = 0; i < discoveredAccounts.length; i += BATCH_SIZE) {
            const batch = discoveredAccounts.slice(i, i + BATCH_SIZE);
            const pubkeys: PublicKey[] = [];

            for (const acc of batch) {
                try {
                    pubkeys.push(new PublicKey(acc.pubkey));
                } catch {
                    // Invalid pubkey, skip
                }
            }

            if (pubkeys.length === 0) continue;

            try {
                const infos = await this.connection.getMultipleAccountsInfo(pubkeys);

                for (let j = 0; j < infos.length; j++) {
                    const info = infos[j];
                    const pubkeyStr = pubkeys[j].toBase58();
                    const originalAcc = batch.find(a => a.pubkey === pubkeyStr);
                    checked++;

                    if (!info) {
                        closed++;
                        reclaimable.push({
                            pubkey: pubkeyStr,
                            userWallet: originalAcc?.userWallet || '',
                            type: originalAcc?.type as any || 'token',
                            lamports: 0,
                            canReclaim: false,
                            status: 'closed'
                        });
                        continue;
                    }

                    const ownerStr = info.owner.toBase58();
                    const isToken = ownerStr === TOKEN_PROGRAM_STR || ownerStr === TOKEN_2022_PROGRAM_STR;

                    if (isToken && info.data.length >= ACCOUNT_SIZE) {
                        const data = AccountLayout.decode(Uint8Array.from(info.data.slice(0, ACCOUNT_SIZE)));
                        const isZeroBalance = data.amount === 0n;
                        const closeAuthority = data.closeAuthorityOption === 1
                            ? data.closeAuthority.toBase58()
                            : data.owner.toBase58();
                        const canClose = closeAuthority === this.operatorAddress.toBase58();

                        if (isZeroBalance) {
                            const type = ownerStr === TOKEN_2022_PROGRAM_STR ? 'token-2022' : 'token';
                            reclaimable.push({
                                pubkey: pubkeyStr,
                                userWallet: originalAcc?.userWallet || '',
                                type,
                                lamports: info.lamports,
                                canReclaim: canClose,
                                reason: canClose ? undefined : `Close authority is ${closeAuthority}`
                            });
                        }
                    }
                }
            } catch (e) {
                console.error(`[KoraScan] Batch analyze failed:`, e);
            }

            if (!this.silent) console.log(`  Checked ${Math.min(i + BATCH_SIZE, discoveredAccounts.length)}/${discoveredAccounts.length} accounts...`);
        }

        const canReclaim = reclaimable.filter(a => a.canReclaim);
        const cannotReclaim = reclaimable.filter(a => !a.canReclaim);
        const totalLamports = canReclaim.reduce((sum, a) => sum + a.lamports, 0);

        if (!this.silent) {
            console.log(`[KoraScan] Analysis complete:`);
            console.log(`  - Checked: ${checked} accounts`);
            console.log(`  - Already closed: ${closed} accounts`);
            console.log(`  - Reclaimable: ${canReclaim.length} accounts (${(totalLamports / 1e9).toFixed(4)} SOL)`);
            if (cannotReclaim.length > 0) {
                console.log(`  - Zero balance but can't reclaim: ${cannotReclaim.length} (operator not close authority)`);
            }
        }

        return reclaimable;
    }
}
