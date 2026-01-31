import { PublicKey } from '@solana/web3.js';

// --- Built-in RPC Patterns ---
const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com/?api-key=';
const TRITON_RPC_BASE = 'https://rpc.triton.one/';
const QUICKNODE_RPC_BASE = 'https://solana-mainnet.quiknode.pro/';
const ALCHEMY_RPC_BASE = 'https://solana-mainnet.g.alchemy.com/v2/';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Universal RPC Resolver
 * Priority: Helius > Triton > Quicknode > Alchemy > Public
 */
export function getActiveRpcUrl(): string {
    const heliusKey = process.env.HELIUS_API_KEY;
    const tritonKey = process.env.TRITON_API_KEY;
    const qnKey = process.env.QUICKNODE_API_KEY;
    const alchemyKey = process.env.ALCHEMY_API_KEY;

    if (heliusKey) return `${HELIUS_RPC_BASE}${heliusKey}`;
    if (tritonKey) return `${TRITON_RPC_BASE}${tritonKey}`;
    if (qnKey) return `${QUICKNODE_RPC_BASE}${qnKey}/`;
    if (alchemyKey) return `${ALCHEMY_RPC_BASE}${alchemyKey}`;

    // Explicit override if provided
    if (process.env.RPC_URL) return process.env.RPC_URL;

    return PUBLIC_RPC;
}

export interface DiscoveryTransaction {
    signature: string;
    slot: number;
    timestamp: number;
    fee: number;
    feePayer: string;
    type: string;
    source: string;
    description: string;
    accountData: Array<{
        account: string;
        nativeBalanceChange: number;
        tokenBalanceChanges: any[];
    }>;
    instructions: Array<{
        programId: string;
        accounts: string[];
        data: string;
        parsed?: any;
        innerInstructions?: any[];
    }>;
}

/**
 * DiscoveryClient - Handles multi-provider indexing and standard RPC fallbacks.
 */
export class DiscoveryClient {
    private heliusKey: string | undefined;
    private heliusBaseUrl: string;

    constructor(apiKey?: string) {
        this.heliusKey = apiKey || process.env.HELIUS_API_KEY;
        this.heliusBaseUrl = 'https://api.helius.xyz/v0';

        const tritonKey = process.env.TRITON_API_KEY;
        const qnKey = process.env.QUICKNODE_API_KEY;
        const alchemyKey = process.env.ALCHEMY_API_KEY;

        if (this.heliusKey) {
            console.log('[Discovery] Helius optimizations enabled.');
        } else if (tritonKey || qnKey || alchemyKey) {
            const provider = tritonKey ? 'Triton' : (qnKey ? 'Quicknode' : 'Alchemy');
            console.log(`[Discovery] Using ${provider} for core RPC. Standard discovery enabled.`);
        } else {
            console.warn('[Discovery] No provider key found. Performance will be limited.');
        }
    }

    /**
     * Internal fetch with retries 
     */
    private async fetchWithRetry(url: string, options: RequestInit = {}, retries = 3): Promise<Response> {
        let lastError;
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, options);
                if (response.status === 429) {
                    const wait = Math.pow(2, i) * 1000;
                    console.log(`  [Discovery] Rate limited (429). Retrying in ${wait}ms...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                if (response.status === 404) {
                    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`Discovery Error (${response.status}): ${text.slice(0, 100)}`);
                }
                return response;
            } catch (e: any) {
                lastError = e;
                const wait = Math.pow(2, i) * 500;
                await new Promise(r => setTimeout(r, wait));
            }
        }
        throw lastError;
    }

    /**
     * Universal Transaction Fetcher - Uses Helius Enhanced API if key exists, 
     * otherwise falls back to standard RPC getSignatures + getParsedTransactions.
     */
    async getTransactionHistory(
        address: string,
        options: {
            before?: string;
            limit?: number;
            type?: string;
            connection?: any;
        } = {}
    ): Promise<DiscoveryTransaction[]> {
        // --- MODE A: Helius Enhanced API ---
        if (this.heliusKey) {
            try {
                const params = new URLSearchParams({
                    'api-key': this.heliusKey,
                });

                if (options.before) params.append('before', options.before);
                if (options.limit) params.append('limit', options.limit.toString());
                if (options.type) params.append('type', options.type);

                const url = `${this.heliusBaseUrl}/addresses/${address}/transactions?${params}`;
                const response = await this.fetchWithRetry(url);
                const data = await response.json();

                // Ensure timestamps are always seconds in DiscoveryTransaction
                return data.map((tx: any) => ({
                    ...tx,
                    timestamp: typeof tx.timestamp === 'string' ? Math.floor(new Date(tx.timestamp).getTime() / 1000) : tx.timestamp
                }));
            } catch (e: any) {
                console.warn(`[Discovery] Helius fetch failed: ${e.message}. Attempting fallback...`);
            }
        }

        // --- MODE B: Standard RPC Fallback ---
        if (!options.connection) {
            throw new Error('[Discovery] Standard RPC fallback requires a Connection object.');
        }

        const pubkey = new PublicKey(address);
        const sigs = await options.connection.getSignaturesForAddress(pubkey, {
            limit: options.limit || 100,
            before: options.before
        });

        if (sigs.length === 0) return [];

        const parsed = await options.connection.getParsedTransactions(sigs.map((s: any) => s.signature), {
            maxSupportedTransactionVersion: 0
        });

        const mapped = parsed.filter((tx: any) => tx !== null).map((tx: any) => {
            const instructions = tx.transaction.message.instructions.map((ix: any) => ({
                programId: ix.programId.toBase58(),
                accounts: ix.accounts?.map((a: any) => a.toBase58()) || [],
                data: ix.data || '',
                parsed: ix.parsed // Include parsed info if available
            }));

            // Attempt to detect transaction type
            let detectedType = 'UNKNOWN';
            const hasSetAuthority = instructions.some((ix: any) =>
                (ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || ix.programId === 'TokenzQdBNbAtYpYbt9UEHJR9YWYvNf2t8S77tB39L') &&
                ix.parsed?.type === 'setAuthority'
            );

            const hasCreateAccount = instructions.some((ix: any) =>
                (ix.programId === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' || ix.programId === '11111111111111111111111111111111') &&
                (ix.parsed?.type === 'create' || ix.parsed?.type === 'createIdempotent')
            );

            if (hasSetAuthority) detectedType = 'SET_AUTHORITY';
            else if (hasCreateAccount) detectedType = 'CREATE_ACCOUNT';

            return {
                signature: tx.transaction.signatures[0],
                slot: tx.slot,
                timestamp: tx.blockTime || 0,
                fee: tx.meta?.fee || 0,
                feePayer: tx.transaction.message.accountKeys[0].pubkey.toBase58(),
                type: detectedType,
                source: instructions.some((ix: any) => ix.programId === '11111111111111111111111111111111') ? 'SYSTEM_PROGRAM' : 'SOLANA_RPC',
                description: detectedType === 'SET_AUTHORITY' ? 'Authority changed for account' : 'Solana Transaction',
                accountData: tx.meta?.postBalances.map((bal: any, idx: number) => {
                    const pubkey = tx.transaction.message.accountKeys[idx].pubkey.toBase58();
                    const tokenBalance = tx.meta?.postTokenBalances?.find((b: any) => b.accountIndex === idx);

                    return {
                        account: pubkey,
                        nativeBalanceChange: bal - (tx.meta?.preBalances[idx] || 0),
                        tokenBalanceChanges: tokenBalance ? [{
                            mint: tokenBalance.mint,
                            userWallet: tokenBalance.owner || '',
                            rawTokenAmount: tokenBalance.uiTokenAmount
                        }] : []
                    };
                }) || [],
                instructions
            };
        });

        // NOTE: We do NOT filter by type here in Standard RPC mode.
        // Standard RPC getSignaturesForAddress doesn't support type filtering.
        // We return the full batch and let the caller loop and process.
        return mapped;
    }

    /**
     * Parse multiple transactions by signature (Helius only)
     */
    async parseTransactions(signatures: string[]): Promise<DiscoveryTransaction[]> {
        if (signatures.length === 0) return [];
        if (!this.heliusKey) throw new Error('[Discovery] Batch parsing requires Helius key.');

        const url = `${this.heliusBaseUrl}/transactions?api-key=${this.heliusKey}`;
        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactions: signatures }),
        });

        return response.json();
    }

    /**
     * Get Program Accounts V2 (Helius only)
     */
    async getProgramAccountsV2(programId: string, options: any = {}): Promise<any> {
        if (!this.heliusKey) throw new Error('[Discovery] getProgramAccountsV2 requires Helius key.');
        const url = `${this.heliusBaseUrl}/program-accounts/${programId}?api-key=${this.heliusKey}`;
        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options),
        });
        return response.json();
    }
}

export const discoveryClient = new DiscoveryClient();
