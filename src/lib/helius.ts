import { PublicKey } from '@solana/web3.js';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_BASE_URL = process.env.HELIUS_API_URL || 'https://api.helius.xyz/v0';

export interface HeliusTransaction {
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
        innerInstructions?: any[];
    }>;
    nativeTransfers?: Array<{
        fromUserAccount: string;
        toUserAccount: string;
        amount: number;
    }>;
    tokenTransfers?: Array<{
        fromUserAccount: string;
        toUserAccount: string;
        mint: string;
        tokenAmount: number;
    }>;
    events?: {
        compressed?: any[];
    };
}

export interface HeliusSponsoredAccount {
    pubkey: string;
    signature: string;
    slot: number;
    type: 'token' | 'token-2022' | 'system';
    fee: number;
    owner: string;
}

/**
 * Helius API Client for fast transaction fetching
 */
export class HeliusClient {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey?: string, rpcUrl?: string) {
        this.apiKey = apiKey || HELIUS_API_KEY;
        this.baseUrl = rpcUrl ? rpcUrl.split('?')[0] : HELIUS_BASE_URL;

        if (!this.apiKey) {
            console.warn('[Helius] No API key provided. Transactions will fail.');
        }
    }

    /**
     * Internal fetch with retries and exponential backoff
     */
    private async fetchWithRetry(url: string, options: RequestInit = {}, retries = 3): Promise<Response> {
        let lastError;
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, options);
                if (response.status === 429) {
                    const wait = Math.pow(2, i) * 1000;
                    console.log(`  [Helius] Rate limited (429). Retrying in ${wait}ms...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                if (response.status === 404) {
                    // 404 on transaction endpoints often just means "no more found within search window"
                    // return a surrogate response that will JSON parse to []
                    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`Helius Error (${response.status}): ${text.slice(0, 100)}`);
                }
                return response;
            } catch (e: any) {
                lastError = e;
                if (e.name === 'AbortError') throw e;
                const wait = Math.pow(2, i) * 500;
                await new Promise(r => setTimeout(r, wait));
            }
        }
        throw lastError;
    }

    /**
     * Get parsed transaction history for an address
     */
    async getTransactionHistory(
        address: string,
        options: {
            before?: string;
            limit?: number;
            type?: string;
        } = {}
    ): Promise<HeliusTransaction[]> {
        const params = new URLSearchParams({
            'api-key': this.apiKey,
        });

        if (options.before) params.append('before', options.before);
        if (options.limit) params.append('limit', options.limit.toString());
        if (options.type) params.append('type', options.type);

        const url = `${this.baseUrl}/addresses/${address}/transactions?${params}`;

        const response = await this.fetchWithRetry(url);
        return response.json();
    }

    /**
     * Parse multiple transactions by signature (batch)
     */
    async parseTransactions(signatures: string[]): Promise<HeliusTransaction[]> {
        if (signatures.length === 0) return [];
        const url = `${this.baseUrl}/transactions?api-key=${this.apiKey}`;

        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactions: signatures }),
        });

        return response.json();
    }

    /**
     * Get Program Accounts V2 (Paginated)
     */
    async getProgramAccountsV2(
        programId: string,
        options: {
            filters?: any[];
            cursor?: string;
        } = {}
    ): Promise<any> {
        const url = `${this.baseUrl}/program-accounts/${programId}?api-key=${this.apiKey}`;

        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filters: options.filters,
                cursor: options.cursor,
                encoding: 'base64'
            }),
        });

        return response.json();
    }

    /**
     * Webhook Management
     */
    async createWebhook(webhookUrl: string, accountAddresses: string[]): Promise<any> {
        const url = `https://api.helius.xyz/v0/webhooks?api-key=${this.apiKey}`;
        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                webhookURL: webhookUrl,
                transactionTypes: ["Any"],
                accountAddresses: accountAddresses,
                webhookType: "enhanced" // Enhanced gives us the rich parsed data we need
            }),
        });
        return response.json();
    }

    async getWebhooks(): Promise<any[]> {
        const url = `https://api.helius.xyz/v0/webhooks?api-key=${this.apiKey}`;
        const response = await this.fetchWithRetry(url);
        return response.json();
    }

    async deleteWebhook(webhookId: string): Promise<void> {
        const url = `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${this.apiKey}`;
        await this.fetchWithRetry(url, {
            method: 'DELETE',
        });
    }


    /**
     * Fast discovery via indexed types or parallel parsing
     */
    async getTransactionsParallel(
        connection: any,
        address: string,
        options: {
            maxTransactions?: number;
            concurrency?: number;
            type?: string;
            onProgress?: (processed: number, total: number) => void;
        } = {}
    ): Promise<HeliusTransaction[]> {
        const maxTxs = options.maxTransactions || 10000;
        const concurrency = options.concurrency || 10;

        console.log(`[Helius] Starting getTransactionsParallel for ${address.slice(0, 8)}... (Type: ${options.type || 'ALL'})`);

        // Discovery Mode A: Type Filtering (Indexed by Helius)
        if (options.type) {
            const txs: HeliusTransaction[] = [];
            let before: string | undefined;

            while (txs.length < maxTxs) {
                try {
                    const batch = await this.getTransactionHistory(address, {
                        type: options.type,
                        limit: 100,
                        before
                    });

                    if (batch.length === 0) break;
                    txs.push(...batch);
                    before = batch[batch.length - 1].signature;

                    if (options.onProgress) options.onProgress(txs.length, maxTxs);
                    if (batch.length < 100) break;
                } catch (e: any) {
                    console.error(`  [Helius] Discovery loop failed: ${e.message}`);
                    break;
                }
            }
            return txs;
        }

        // Discovery Mode B: Global History via RPC (Slower but exhaustive)
        const allSignatures: string[] = [];
        let rpcBefore: string | undefined;
        let pubkey;
        try {
            pubkey = new PublicKey(address);
        } catch {
            throw new Error(`Invalid address: ${address}`);
        }

        while (allSignatures.length < maxTxs) {
            try {
                const sigs: any[] = await connection.getSignaturesForAddress(pubkey, {
                    limit: Math.min(maxTxs - allSignatures.length, 1000),
                    before: rpcBefore
                });

                if (sigs.length === 0) break;
                allSignatures.push(...sigs.map(s => s.signature));
                rpcBefore = sigs[sigs.length - 1].signature;
                if (sigs.length < 1000) break;
            } catch (e: any) {
                console.error(`  [RPC] Signature fetch failed: ${e.message}`);
                break;
            }
        }

        if (allSignatures.length === 0) return [];

        // Parallel Parsing
        const chunks: string[][] = [];
        for (let i = 0; i < allSignatures.length; i += 100) {
            chunks.push(allSignatures.slice(i, i + 100));
        }

        const results: HeliusTransaction[] = [];
        let processed = 0;

        const processChunk = async (chunk: string[]) => {
            try {
                const parsed = await this.parseTransactions(chunk);
                results.push(...parsed);
                processed += chunk.length;
                if (options.onProgress) options.onProgress(processed, allSignatures.length);
            } catch (e: any) {
                console.warn(`  [Helius] Parallel parse batch failed: ${e.message}`);
            }
        };

        for (let i = 0; i < chunks.length; i += concurrency) {
            const window = chunks.slice(i, i + concurrency);
            await Promise.all(window.map(processChunk));
        }

        return results.sort((a, b) => b.slot - a.slot);
    }
}

export const heliusClient = new HeliusClient();
