import { Request, Response } from 'express';
import { batchUpsertAccounts, SponsoredAccount } from './database';
import { PublicKey } from '@solana/web3.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * Handle incoming Helius Enhanced Transaction webhooks
 */
export async function handleHeliusWebhook(req: Request, res: Response, operatorAddress: string) {
    const transactions = req.body;

    if (!Array.isArray(transactions)) {
        return res.status(400).send('Invalid webhook payload');
    }

    console.log(`[Webhook] Received ${transactions.length} transactions`);

    const discovered: SponsoredAccount[] = [];

    for (const tx of transactions) {
        // We look for transactions where the operator is the fee payer (sponsorship)
        if (tx.feePayer !== operatorAddress) continue;

        for (const accData of tx.accountData || []) {
            const acc = accData.account;
            const balanceChange = accData.nativeBalanceChange;

            // Kora pattern: Rent sponsorship is typically ~0.002 SOL (2,039,280 lamports)
            if (balanceChange < 1000000 || balanceChange > 3000000) continue;

            let type: 'token' | 'token-2022' | 'system' = 'system';
            let userWallet = '';
            let mint = '';

            // Find instructions that created this account
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

            if (type === 'token' || type === 'token-2022') {
                discovered.push({
                    pubkey: acc,
                    operator: operatorAddress,
                    userWallet: userWallet || 'UNKNOWN',
                    mint: mint || 'UNKNOWN',
                    type,
                    rentPaid: balanceChange,
                    signature: tx.signature || 'WEBHOOK_DISCOVERY',
                    slot: tx.slot || 0,
                    status: 'active'
                });
            }
        }
    }

    if (discovered.length > 0) {
        console.log(`[Webhook] Discovered ${discovered.length} new sponsored accounts!`);
        try {
            await batchUpsertAccounts(discovered);
        } catch (e: any) {
            console.error(`[Webhook] Database error:`, e.message);
            return res.status(500).send('Database Error');
        }
    }

    res.status(200).send('OK');
}

