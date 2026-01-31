import { Connection, PublicKey, GetProgramAccountsFilter } from '@solana/web3.js';
import { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { DiscoveredAccount } from './discoverer';
import { DiscoveryClient } from './rpc';

const TOKEN_PROGRAM_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_STR = 'TokenzQdBNbAtYpYbt9UEHJR9YWYvNf2t8S77tB39L';

export interface ReclaimableAccount {
    pubkey: string;
    userWallet: string;
    mint: string;
    type: 'token' | 'token-2022' | 'system';
    lamports: number;
    canReclaim: boolean;
    status?: 'active' | 'reclaimable' | 'closed' | 'locked';
    reason?: string;
    sponsorshipSource?: string;
    memo?: string;
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
    heliusClient: DiscoveryClient | null;

    constructor(connection: Connection, operatorAddress: PublicKey, silent = false, heliusClient: DiscoveryClient | null = null) {
        this.connection = connection;
        this.operatorAddress = operatorAddress;
        this.silent = silent;
        this.heliusClient = heliusClient;
    }

    /**
     * Analyze discovered accounts to find reclaimable ones
     */
    async analyzeAccounts(discoveredAccounts: DiscoveredAccount[]): Promise<ReclaimableAccount[]> {
        if (!this.silent) console.log(`[KoraScan] Analyzing ${discoveredAccounts.length} discovered accounts...`);

        if (discoveredAccounts.length === 0) {
            return [];
        }

        const reclaimable: ReclaimableAccount[] = [];
        const BATCH_SIZE = 100;
        let checked = 0;
        let closed = 0;

        for (let i = 0; i < discoveredAccounts.length; i += BATCH_SIZE) {
            const batch = discoveredAccounts.slice(i, i + BATCH_SIZE);
            const pubkeys: PublicKey[] = [];

            for (const acc of batch) {
                try {
                    pubkeys.push(new PublicKey(acc.pubkey));
                } catch { }
            }

            if (pubkeys.length === 0) continue;

            try {
                const infos = await this.connection.getMultipleAccountsInfo(pubkeys);

                for (let j = 0; j < (infos?.length || 0); j++) {
                    const info = infos[j];
                    const pubkeyStr = pubkeys[j].toBase58();
                    const originalAcc = batch.find(a => a.pubkey === pubkeyStr);
                    checked++;

                    if (!info) {
                        closed++;
                        if (!this.silent) console.log(`  [CLOSED] ${pubkeyStr.slice(0, 8)}... | Account no longer exists on-chain.`);
                        continue;
                    }

                    const ownerStr = info.owner.toBase58();
                    const isToken = ownerStr === TOKEN_PROGRAM_STR || ownerStr === TOKEN_2022_PROGRAM_STR;

                    if (isToken && info.data.length >= ACCOUNT_SIZE) {
                        const data = AccountLayout.decode(Uint8Array.from(info.data.slice(0, ACCOUNT_SIZE)));

                        const isZeroBalance = data.amount === 0n;
                        const closeAuthority = data.closeAuthorityOption === 1
                            ? new PublicKey(data.closeAuthority).toBase58()
                            : '';
                        const canClose = closeAuthority === this.operatorAddress.toBase58();

                        if (isZeroBalance) {
                            reclaimable.push({
                                pubkey: pubkeyStr,
                                userWallet: data.owner.toBase58(),
                                mint: new PublicKey(data.mint).toBase58(),
                                type: ownerStr === TOKEN_2022_PROGRAM_STR ? 'token-2022' : 'token',
                                lamports: info.lamports,
                                canReclaim: canClose,
                                reason: canClose ? undefined : 'authority_mismatch',
                                sponsorshipSource: originalAcc?.sponsorshipSource,
                                memo: originalAcc?.memo
                            });
                            if (!this.silent) {
                                if (canClose) {
                                    console.log(`  [RECLAIMABLE] ${pubkeyStr.slice(0, 8)}... | balance=0, closeAuth=operator | ~${(info.lamports / 1e9).toFixed(4)} SOL`);
                                } else {
                                    console.log(`  [SKIP] ${pubkeyStr.slice(0, 8)}... | Reason: AUTHORITY_MISMATCH | closeAuth != operator`);
                                }
                            }
                        } else {
                            // Even if not zero balance, return info to update DB
                            reclaimable.push({
                                pubkey: pubkeyStr,
                                userWallet: data.owner.toBase58(),
                                mint: new PublicKey(data.mint).toBase58(),
                                type: ownerStr === TOKEN_2022_PROGRAM_STR ? 'token-2022' : 'token',
                                lamports: info.lamports,
                                canReclaim: false,
                                reason: 'balance_nonzero'
                            });
                            if (!this.silent) console.log(`  [SKIP] ${pubkeyStr.slice(0, 8)}... | Reason: NON_ZERO_BALANCE | Account still holds tokens`);
                        }
                    } else {
                        // Even if not zero balance, we want to return the info to update the DB
                        reclaimable.push({
                            pubkey: pubkeyStr,
                            userWallet: originalAcc?.userWallet || '',
                            mint: '', // Not a token account, so no mint
                            type: 'system', // Assuming system account if not token
                            lamports: info.lamports,
                            canReclaim: false,
                            reason: 'not_token_account'
                        });
                    }
                }
            } catch (e) {
                console.error(`[KoraScan] Batch analyze failed:`, e);
            }
        }

        return reclaimable;
    }
}
