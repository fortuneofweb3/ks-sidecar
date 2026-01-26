/**
 * Turso Cloud Database Client
 * 
 * Used by both web dashboard and telegram bot.
 * Supports incremental scanning - first scan fetches all, 
 * subsequent scans only fetch new transactions.
 */
import { createClient, Client } from '@libsql/client';

// Database Configuration
const LOCAL_DB_PATH = process.env.LOCAL_DB_PATH || 'korascan_local.db';
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

let client: Client | null = null;

export function getClient(): Client {
    if (!client) {
        if (TURSO_URL && TURSO_TOKEN) {
            console.log('[Database] Using Turso Cloud');
            client = createClient({
                url: TURSO_URL,
                authToken: TURSO_TOKEN,
            });
        } else {
            console.log(`[Database] Using local SQLite: ${LOCAL_DB_PATH}`);
            client = createClient({
                url: `file:${LOCAL_DB_PATH}`,
            });
        }
    }
    return client;
}

export async function initDb(): Promise<void> {
    const db = getClient();

    // Sponsored accounts table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS sponsored_accounts (
            pubkey TEXT PRIMARY KEY,
            operator TEXT NOT NULL,
            user_wallet TEXT,
            mint TEXT,
            type TEXT,
            rent_paid INTEGER DEFAULT 0,
            signature TEXT NOT NULL,
            slot INTEGER NOT NULL,
            status TEXT DEFAULT 'active',
            last_checked INTEGER,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        )
    `);

    // Scan checkpoints for incremental scanning
    await db.execute(`
        CREATE TABLE IF NOT EXISTS scan_checkpoints (
            operator TEXT PRIMARY KEY,
            oldest_signature TEXT,
            newest_signature TEXT,
            oldest_slot INTEGER,
            newest_slot INTEGER,
            total_accounts INTEGER DEFAULT 0,
            reclaimable_count INTEGER DEFAULT 0,
            reclaimable_lamports INTEGER DEFAULT 0,
            scan_status TEXT DEFAULT 'pending',
            first_scan_complete INTEGER DEFAULT 0,
            last_scan_at INTEGER,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        )
    `);

    // User Settings Table (for telegram)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS user_settings (
            chat_id INTEGER PRIMARY KEY,
            watched_address TEXT,
            notify_rent_found BOOLEAN DEFAULT 1,
            notify_rent_claimed BOOLEAN DEFAULT 1,
            notify_all_txs BOOLEAN DEFAULT 0
        )
    `);

    // Operator Fee History
    await db.execute(`
        CREATE TABLE IF NOT EXISTS operator_fee_history (
            signature TEXT PRIMARY KEY,
            operator TEXT NOT NULL,
            fee_lamports INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            tx_type TEXT,
            slot INTEGER
        )
    `);



    // Whitelist table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS whitelist (
            address TEXT PRIMARY KEY,
            note TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        )
    `);

    // Indexes for fast queries
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_operator_status ON sponsored_accounts(operator, status)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_operator_wallet ON sponsored_accounts(operator, user_wallet)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_operator_slot ON sponsored_accounts(operator, slot)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_user_wallet ON sponsored_accounts(user_wallet)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_fee_operator ON operator_fee_history(operator)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_fee_timestamp ON operator_fee_history(timestamp)`);

    // Migration: Add initial_timestamp if it doesn't exist
    try {
        await db.execute("ALTER TABLE sponsored_accounts ADD COLUMN initial_timestamp INTEGER");
        console.log('[Database] Migrated: Added initial_timestamp column');
    } catch (e: any) {
        // Column already exists or other error we can ignore for now
    }

    // Migration: Add reclaimed_at and reclaim_signature
    try {
        await db.execute("ALTER TABLE sponsored_accounts ADD COLUMN reclaimed_at INTEGER");
        await db.execute("ALTER TABLE sponsored_accounts ADD COLUMN reclaim_signature TEXT");
        console.log('[Database] Migrated: Added reclaim tracking columns');
    } catch (e) {
        // columns exist
    }

    // Migration: Add sponsorship_source and memo
    try {
        await db.execute("ALTER TABLE sponsored_accounts ADD COLUMN sponsorship_source TEXT");
        await db.execute("ALTER TABLE sponsored_accounts ADD COLUMN memo TEXT");
        console.log('[Database] Migrated: Added source/memo columns');
    } catch (e) {
        // columns exist
    }

    console.log('[Database] Tables initialized');
}

/** @deprecated Use initDb */
export const initTursoDb = initDb;

// ============ Sponsored Accounts ============

export interface SponsoredAccount {
    pubkey: string;
    operator: string;
    userWallet: string;
    mint: string;
    type: string;
    rentPaid: number;
    signature: string;
    slot: number;
    initialTimestamp?: number;
    reclaimedAt?: number;
    reclaimSignature?: string;
    sponsorshipSource?: string;
    memo?: string;
    status: string;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
    try {
        return await fn();
    } catch (e: any) {
        if (retries > 0 && (e.message.includes('ETIMEDOUT') || e.message.includes('ECONNRESET'))) {
            console.warn(`[Database] Transient error, retrying in ${delay}ms... (${retries} left)`);
            await new Promise(r => setTimeout(r, delay));
            return withRetry(fn, retries - 1, delay * 2);
        }
        throw e;
    }
}

export async function upsertSponsoredAccount(account: SponsoredAccount): Promise<void> {
    const db = getClient();
    await withRetry(() => db.execute({
        sql: `
            INSERT INTO sponsored_accounts (
                pubkey, operator, user_wallet, mint, type, rent_paid, signature, slot, initial_timestamp, 
                reclaimed_at, reclaim_signature, sponsorship_source, memo, status, last_checked
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(pubkey) DO UPDATE SET
                status = excluded.status,
                last_checked = excluded.last_checked,
                initial_timestamp = COALESCE(excluded.initial_timestamp, initial_timestamp),
                reclaimed_at = COALESCE(excluded.reclaimed_at, reclaimed_at),
                reclaim_signature = COALESCE(excluded.reclaim_signature, reclaim_signature),
                sponsorship_source = COALESCE(excluded.sponsorship_source, sponsorship_source),
                memo = COALESCE(excluded.memo, memo)
        `,
        args: [
            account.pubkey, account.operator, account.userWallet, account.mint, account.type,
            account.rentPaid, account.signature, account.slot, account.initialTimestamp || 0,
            account.reclaimedAt || null, account.reclaimSignature || null,
            account.sponsorshipSource || null, account.memo || null,
            account.status, Date.now()
        ]
    }));
}

export async function batchUpsertAccounts(accounts: SponsoredAccount[]): Promise<void> {
    if (accounts.length === 0) return;

    const db = getClient();
    const batch = accounts.map(acc => ({
        sql: `
            INSERT INTO sponsored_accounts (
                pubkey, operator, user_wallet, mint, type, rent_paid, signature, slot, initial_timestamp, 
                reclaimed_at, reclaim_signature, sponsorship_source, memo, status, last_checked
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(pubkey) DO UPDATE SET
                status = excluded.status,
                last_checked = excluded.last_checked,
                initial_timestamp = COALESCE(excluded.initial_timestamp, initial_timestamp),
                reclaimed_at = COALESCE(excluded.reclaimed_at, reclaimed_at),
                reclaim_signature = COALESCE(excluded.reclaim_signature, reclaim_signature),
                sponsorship_source = COALESCE(excluded.sponsorship_source, sponsorship_source),
                memo = COALESCE(excluded.memo, memo)
        `,
        args: [
            acc.pubkey, acc.operator, acc.userWallet, acc.mint, acc.type,
            acc.rentPaid, acc.signature, acc.slot, acc.initialTimestamp || 0,
            acc.reclaimedAt || null, acc.reclaimSignature || null,
            acc.sponsorshipSource || null, acc.memo || null,
            acc.status, Date.now()
        ]
    }));

    await withRetry(() => db.batch(batch));
}

export async function getAccountsForOperator(operator: string): Promise<SponsoredAccount[]> {
    const db = getClient();
    const result = await withRetry(() => db.execute({
        sql: 'SELECT * FROM sponsored_accounts WHERE operator = ? ORDER BY slot DESC',
        args: [operator]
    }));

    return result.rows.map(row => ({
        pubkey: row.pubkey as string,
        operator: row.operator as string,
        userWallet: row.user_wallet as string,
        mint: row.mint as string,
        type: row.type as string,
        rentPaid: row.rent_paid as number,
        signature: row.signature as string,
        slot: row.slot as number,
        initialTimestamp: row.initial_timestamp as number,
        reclaimedAt: row.reclaimed_at as number,
        reclaimSignature: row.reclaim_signature as string,
        sponsorshipSource: row.sponsorship_source as string,
        memo: row.memo as string,
        status: row.status as string,
    }));
}

export async function getAllAccounts(operator: string): Promise<SponsoredAccount[]> {
    const db = getClient();
    const result = await withRetry(() => db.execute({
        sql: 'SELECT * FROM sponsored_accounts WHERE operator = ? ORDER BY initial_timestamp DESC',
        args: [operator]
    }));

    return result.rows.map(row => ({
        pubkey: row.pubkey as string,
        operator: row.operator as string,
        userWallet: row.user_wallet as string,
        mint: row.mint as string,
        type: row.type as string,
        rentPaid: Number(row.rent_paid || 0),
        signature: row.signature as string,
        slot: row.slot as number,
        initialTimestamp: row.initial_timestamp as number,
        reclaimedAt: row.reclaimed_at as number,
        reclaimSignature: row.reclaim_signature as string,
        sponsorshipSource: row.sponsorship_source as string,
        memo: row.memo as string,
        status: row.status as string,
    }));
}

export async function updateAccountStatus(pubkey: string, status: string, reclaimedAt?: number, reclaimSignature?: string): Promise<void> {
    const db = getClient();
    const sql = reclaimedAt && reclaimSignature
        ? 'UPDATE sponsored_accounts SET status = ?, last_checked = ?, reclaimed_at = ?, reclaim_signature = ? WHERE pubkey = ?'
        : 'UPDATE sponsored_accounts SET status = ?, last_checked = ? WHERE pubkey = ?';

    const args = reclaimedAt && reclaimSignature
        ? [status, Date.now(), reclaimedAt, reclaimSignature, pubkey]
        : [status, Date.now(), pubkey];

    await withRetry(() => db.execute({ sql, args }));
}

export async function batchUpdateStatus(pubkeys: string[], status: string): Promise<void> {
    if (pubkeys.length === 0) return;
    const db = getClient();
    const batch = pubkeys.map(pk => ({
        sql: 'UPDATE sponsored_accounts SET status = ?, last_checked = ? WHERE pubkey = ?',
        args: [status, Date.now(), pk]
    }));
    await withRetry(() => db.batch(batch));
}

export async function batchUpdateAccountMetadata(updates: {
    pubkey: string,
    mint?: string,
    userWallet?: string,
    status?: string,
    initialTimestamp?: number,
    sponsorshipSource?: string,
    memo?: string
}[]): Promise<void> {
    if (updates.length === 0) return;
    const db = getClient();
    const batch = updates.map(u => ({
        sql: `UPDATE sponsored_accounts SET 
                mint = COALESCE(NULLIF(?, ''), mint), 
                user_wallet = COALESCE(NULLIF(?, ''), user_wallet),
                status = COALESCE(?, status),
                initial_timestamp = COALESCE(?, initial_timestamp),
                sponsorship_source = COALESCE(?, sponsorship_source),
                memo = COALESCE(?, memo),
                last_checked = ? 
              WHERE pubkey = ?`,
        args: [
            u.mint || '',
            u.userWallet || '',
            u.status || null,
            u.initialTimestamp || null,
            u.sponsorshipSource || null,
            u.memo || null,
            Date.now(),
            u.pubkey
        ]
    }));
    await withRetry(() => db.batch(batch));
}



export async function getActiveAccountsForOperator(operator: string, limit: number = 100): Promise<SponsoredAccount[]> {
    const db = getClient();
    const result = await withRetry(() => db.execute({
        sql: "SELECT * FROM sponsored_accounts WHERE operator = ? AND status = 'active' ORDER BY last_checked ASC LIMIT ?",
        args: [operator, limit]
    }));

    return result.rows.map(row => ({
        pubkey: row.pubkey as string,
        operator: row.operator as string,
        userWallet: row.user_wallet as string,
        mint: row.mint as string,
        type: row.type as string,
        rentPaid: row.rent_paid as number,
        signature: row.signature as string,
        slot: row.slot as number,
        initialTimestamp: row.initial_timestamp as number,
        status: row.status as string,
    }));
}

// ============ User Settings ============

export interface UserSettings {
    chat_id: number;
    watched_address: string;
    notify_rent_found: boolean;
    notify_rent_claimed: boolean;
    notify_all_txs: boolean;
}

export async function upsertUserSetting(chatId: number, address: string): Promise<void> {
    const db = getClient();
    await withRetry(() => db.execute({
        sql: `
            INSERT INTO user_settings (chat_id, watched_address)
            VALUES (?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET watched_address = excluded.watched_address
        `,
        args: [chatId, address]
    }));
}

export async function getUserSettings(chatId: number): Promise<UserSettings | null> {
    const db = getClient();
    const result = await withRetry(() => db.execute({
        sql: "SELECT * FROM user_settings WHERE chat_id = ?",
        args: [chatId]
    }));

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
        chat_id: row.chat_id as number,
        watched_address: row.watched_address as string,
        notify_rent_found: row.notify_rent_found === 1,
        notify_rent_claimed: row.notify_rent_claimed === 1,
        notify_all_txs: row.notify_all_txs === 1,
    };
}

export async function getAllUsersWithAlerts(): Promise<UserSettings[]> {
    const db = getClient();
    const result = await withRetry(() => db.execute("SELECT * FROM user_settings"));
    return result.rows.map(row => ({
        chat_id: row.chat_id as number,
        watched_address: row.watched_address as string,
        notify_rent_found: row.notify_rent_found === 1,
        notify_rent_claimed: row.notify_rent_claimed === 1,
        notify_all_txs: row.notify_all_txs === 1,
    }));
}

export async function toggleNotification(chatId: number, type: 'notify_rent_found' | 'notify_rent_claimed' | 'notify_all_txs', value: boolean): Promise<void> {
    const db = getClient();
    const validColumns = ['notify_rent_found', 'notify_rent_claimed', 'notify_all_txs'];
    if (!validColumns.includes(type)) return;

    await withRetry(() => db.execute({
        sql: `UPDATE user_settings SET ${type} = ? WHERE chat_id = ?`,
        args: [value ? 1 : 0, chatId]
    }));
}

// ============ Operator Fee History ============

export async function addOperatorFee(signature: string, operator: string, feeLamports: number, timestamp: number, txType: string, slot: number): Promise<void> {
    const db = getClient();
    await withRetry(() => db.execute({
        sql: `INSERT OR IGNORE INTO operator_fee_history (signature, operator, fee_lamports, timestamp, tx_type, slot) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [signature, operator, feeLamports, timestamp, txType, slot]
    }));
}

export async function batchAddOperatorFees(fees: Array<{ signature: string, operator: string, feeLamports: number, timestamp: number, txType: string, slot: number }>): Promise<void> {
    if (fees.length === 0) return;
    const db = getClient();
    const batch = fees.map(f => ({
        sql: `INSERT OR IGNORE INTO operator_fee_history (signature, operator, fee_lamports, timestamp, tx_type, slot) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [f.signature, f.operator, f.feeLamports, f.timestamp, f.txType, f.slot]
    }));
    await withRetry(() => db.batch(batch));
}

export async function getOperatorTotalFees(operator: string): Promise<{
    totalFees: number;
    totalFeesLamports: number;
    txCount: number;
    firstTx: number | null;
    lastTx: number | null;
}> {
    const db = getClient();
    const result = await withRetry(() => db.execute({
        sql: `
            SELECT
                SUM(fee_lamports) as total_fees,
                COUNT(*) as tx_count,
                MIN(timestamp) as first_tx,
                MAX(timestamp) as last_tx
            FROM operator_fee_history
            WHERE operator = ?
        `,
        args: [operator]
    }));

    const row = result.rows[0];
    const totalFeesLamports = Number(row.total_fees || 0);
    return {
        totalFees: totalFeesLamports / 1e9,
        totalFeesLamports,
        txCount: Number(row.tx_count || 0),
        firstTx: row.first_tx as number | null,
        lastTx: row.last_tx as number | null,
    };
}

// ============ Scan Checkpoints ============

export interface ScanCheckpoint {
    operator: string;
    oldestSignature: string | null;
    newestSignature: string | null;
    oldestSlot: number | null;
    newestSlot: number | null;
    totalAccounts: number;
    reclaimableCount: number;
    reclaimableLamports: number;
    scanStatus: string;
    firstScanComplete: boolean;
    lastScanAt: number | null;
}

export async function getCheckpoint(operator: string): Promise<ScanCheckpoint | null> {
    const db = getClient();
    const result = await withRetry(() => db.execute({
        sql: 'SELECT * FROM scan_checkpoints WHERE operator = ?',
        args: [operator]
    }));

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
        operator: row.operator as string,
        oldestSignature: row.oldest_signature as string | null,
        newestSignature: row.newest_signature as string | null,
        oldestSlot: row.oldest_slot as number | null,
        newestSlot: row.newest_slot as number | null,
        totalAccounts: row.total_accounts as number,
        reclaimableCount: row.reclaimable_count as number,
        reclaimableLamports: row.reclaimable_lamports as number,
        scanStatus: row.scan_status as string,
        firstScanComplete: row.first_scan_complete === 1,
        lastScanAt: row.last_scan_at as number | null,
    };
}

export async function updateCheckpoint(checkpoint: Partial<ScanCheckpoint> & { operator: string }): Promise<void> {
    const db = getClient();
    await withRetry(() => db.execute({
        sql: `
            INSERT INTO scan_checkpoints (operator, oldest_signature, newest_signature, oldest_slot, newest_slot, total_accounts, reclaimable_count, reclaimable_lamports, scan_status, first_scan_complete, last_scan_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(operator) DO UPDATE SET
                oldest_signature = COALESCE(excluded.oldest_signature, oldest_signature),
                newest_signature = COALESCE(excluded.newest_signature, newest_signature),
                oldest_slot = COALESCE(excluded.oldest_slot, oldest_slot),
                newest_slot = COALESCE(excluded.newest_slot, newest_slot),
                total_accounts = excluded.total_accounts,
                reclaimable_count = excluded.reclaimable_count,
                reclaimable_lamports = excluded.reclaimable_lamports,
                scan_status = excluded.scan_status,
                first_scan_complete = excluded.first_scan_complete,
                last_scan_at = excluded.last_scan_at
        `,
        args: [
            checkpoint.operator,
            checkpoint.oldestSignature || null,
            checkpoint.newestSignature || null,
            checkpoint.oldestSlot || null,
            checkpoint.newestSlot || null,
            checkpoint.totalAccounts || 0,
            checkpoint.reclaimableCount || 0,
            checkpoint.reclaimableLamports || 0,
            checkpoint.scanStatus || 'pending',
            checkpoint.firstScanComplete ? 1 : 0,
            Date.now()
        ]
    }));
}

// ============ Query Helpers ============

export async function getOperatorStats(operator: string): Promise<{
    totalAccounts: number;
    activeAccounts: number;
    closedAccounts: number;
    reclaimableAccounts: number;
    reclaimableLamports: number;
    lockedAccounts: number;
}> {
    const db = getClient();
    const result = await withRetry(() => db.execute({
        sql: `
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
                SUM(CASE WHEN status = 'reclaimable' THEN 1 ELSE 0 END) as reclaimable,
                SUM(CASE WHEN status = 'reclaimable' THEN rent_paid ELSE 0 END) as reclaimable_lamports,
                SUM(CASE WHEN status = 'locked' THEN 1 ELSE 0 END) as locked
            FROM sponsored_accounts WHERE operator = ?
        `,
        args: [operator]
    }));

    const row = result.rows[0];
    return {
        totalAccounts: Number(row.total || 0),
        activeAccounts: Number(row.active || 0),
        closedAccounts: Number(row.closed || 0),
        reclaimableAccounts: Number(row.reclaimable || 0),
        reclaimableLamports: Number(row.reclaimable_lamports || 0),
        lockedAccounts: Number(row.locked || 0),
    };
}

export async function getAccountsByUserWallet(operator: string): Promise<Map<string, SponsoredAccount[]>> {
    const accounts = await getAccountsForOperator(operator);
    const grouped = new Map<string, SponsoredAccount[]>();

    for (const acc of accounts) {
        const wallet = acc.userWallet || 'unknown';
        if (!grouped.has(wallet)) grouped.set(wallet, []);
        grouped.get(wallet)!.push(acc);
    }

    return grouped;
}

export async function getReclaimableAccounts(operator?: string): Promise<SponsoredAccount[]> {
    const db = getClient();
    let sql = "SELECT * FROM sponsored_accounts WHERE status = 'reclaimable'";
    let args: any[] = [];

    if (operator) {
        sql += " AND operator = ?";
        args.push(operator);
    }

    const result = await withRetry(() => db.execute({ sql, args }));

    return result.rows.map(row => ({
        pubkey: row.pubkey as string,
        operator: row.operator as string,
        userWallet: row.user_wallet as string,
        mint: row.mint as string,
        type: row.type as string,
        rentPaid: Number(row.rent_paid || 0),
        signature: row.signature as string,
        slot: row.slot as number,
        initialTimestamp: row.initial_timestamp as number,
        status: row.status as string,
    }));
}

export async function getGlobalCloudStats(): Promise<{
    trackedAccounts: number;
    reclaimedCount: number;
    totalReclaimed: number;
    reclaimableCount: number;
    reclaimableSol: number;
    lockedCount: number;
    trackedOperators: number;
}> {
    const db = getClient();
    const result = await withRetry(() => db.execute(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'reclaimed' THEN 1 ELSE 0 END) as reclaimed_count,
            SUM(CASE WHEN status = 'reclaimed' THEN rent_paid ELSE 0 END) as reclaimed_lamports,
            SUM(CASE WHEN status = 'reclaimable' THEN 1 ELSE 0 END) as reclaimable_count,
            SUM(CASE WHEN status = 'reclaimable' THEN rent_paid ELSE 0 END) as reclaimable_lamports,
            SUM(CASE WHEN status = 'locked' THEN 1 ELSE 0 END) as locked_count,
            (SELECT COUNT(*) FROM scan_checkpoints) as operator_count
        FROM sponsored_accounts
    `));

    const row = result.rows[0];
    return {
        trackedAccounts: Number(row.total || 0),
        reclaimedCount: Number(row.reclaimed_count || 0),
        totalReclaimed: Number(row.reclaimed_lamports || 0) / 1e9,
        reclaimableCount: Number(row.reclaimable_count || 0),
        reclaimableSol: Number(row.reclaimable_lamports || 0) / 1e9,
        lockedCount: Number(row.locked_count || 0),
        trackedOperators: Number(row.operator_count || 0),
    };
}

// ============ Analytics & Config ============

export async function getDetailedAnalytics(operator: string) {
    const db = getClient();
    const stats = await db.execute({
        sql: `
            SELECT 
                COUNT(*) as total_accounts,
                COUNT(DISTINCT user_wallet) as unique_users,
                SUM(rent_paid) as total_reclaimed_lamports, -- Actually total INTENT of rent
                SUM(CASE WHEN status = 'reclaimed' OR status = 'closed' THEN rent_paid ELSE 0 END) as realized_rent,
                COUNT(DISTINCT mint) as unique_mints,
                SUM(CASE WHEN sponsorship_source IS NOT NULL THEN 1 ELSE 0 END) as has_birth_cert,
                SUM(CASE WHEN reclaimed_at IS NOT NULL THEN 1 ELSE 0 END) as has_death_cert,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active_count,
                COUNT(CASE WHEN status = 'locked' THEN 1 END) as locked_count
            FROM sponsored_accounts
            WHERE operator = ?
        `,
        args: [operator]
    });

    const mints = await db.execute({
        sql: `
            SELECT mint, COUNT(*) as count 
            FROM sponsored_accounts 
            WHERE operator = ? AND mint != ''
            GROUP BY mint 
            ORDER BY count DESC 
            LIMIT 10
        `,
        args: [operator]
    });

    const feeStats = await getOperatorTotalFees(operator);

    return {
        ...stats.rows[0],
        top_mints: mints.rows,
        total_fees_lamports: feeStats.totalFeesLamports,
        tx_count: feeStats.txCount
    };
}

export async function addToWhitelist(address: string, note: string = '') {
    const db = getClient();
    await db.execute({
        sql: 'INSERT OR REPLACE INTO whitelist (address, note) VALUES (?, ?)',
        args: [address, note]
    });
}

export async function removeFromWhitelist(address: string) {
    const db = getClient();
    await db.execute({
        sql: 'DELETE FROM whitelist WHERE address = ?',
        args: [address]
    });
}

export async function getWhitelist(): Promise<string[]> {
    const db = getClient();
    const result = await db.execute('SELECT address FROM whitelist');
    return result.rows.map(r => r.address as string);
}

export async function getRecentActivity(limit: number): Promise<any[]> {
    const db = getClient();
    const result = await db.execute({
        sql: `
            SELECT pubkey, rent_paid, last_checked as timestamp
            FROM sponsored_accounts
            WHERE status = 'reclaimed' OR status = 'closed'
            ORDER BY last_checked DESC
            LIMIT ?
        `,
        args: [limit]
    });
    return result.rows;
}

