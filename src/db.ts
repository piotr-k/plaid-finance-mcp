import fs from "node:fs";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH } from "./config.js";

export interface ItemRow {
  item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  cursor: string | null;
  last_synced_at: string | null;
  status: string; // ok | login_required | error
  error_code: string | null;
  created_at: string;
}

export interface AccountRow {
  account_id: string;
  item_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  current: number | null;
  available: number | null;
  limit_amount: number | null;
  iso_currency_code: string | null;
  balance_updated_at: string | null;
}

export interface TransactionRow {
  transaction_id: string;
  account_id: string;
  item_id: string;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  original_description: string | null;
  amount: number; // Plaid sign: positive = money out
  iso_currency_code: string | null;
  pending: number; // 0/1
  pending_transaction_id: string | null;
  category_primary: string | null;
  category_detailed: string | null;
  category_confidence: string | null;
  payment_channel: string | null;
  updated_at: string;
}

export interface LiabilityRow {
  account_id: string;
  item_id: string;
  kind: string; // credit | mortgage | student | loan | line_of_credit
  payload: string; // JSON of the Plaid liability object
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  item_id TEXT PRIMARY KEY,
  institution_id TEXT,
  institution_name TEXT,
  cursor TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  official_name TEXT,
  mask TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  current REAL,
  available REAL,
  limit_amount REAL,
  iso_currency_code TEXT,
  balance_updated_at TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  authorized_date TEXT,
  name TEXT NOT NULL,
  merchant_name TEXT,
  original_description TEXT,
  amount REAL NOT NULL,
  iso_currency_code TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  pending_transaction_id TEXT,
  category_primary TEXT,
  category_detailed TEXT,
  category_confidence TEXT,
  payment_channel TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_pending_id ON transactions(pending_transaction_id);
CREATE TABLE IF NOT EXISTS liabilities (
  account_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Hosted mode only: access tokens encrypted with AES-256-GCM (see tokens.ts)
CREATE TABLE IF NOT EXISTS tokens (
  item_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Hosted mode only: OAuth 2.1 authorization server state (see oauth.ts)
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_pending (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expires_at INTEGER NOT NULL, bind_hash TEXT);
CREATE TABLE IF NOT EXISTS oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, scopes TEXT, resource TEXT, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_failures (ts INTEGER NOT NULL, ip TEXT NOT NULL, req_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_login_failures_ts ON login_failures(ts);
-- Hosted Link sessions awaiting completion (see hosted-link.ts)
CREATE TABLE IF NOT EXISTS link_sessions (
  link_token TEXT PRIMARY KEY,
  update_item_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT
);
`;

export type DB = ReturnType<typeof openDb>;

export function openDb(file: string = DB_PATH) {
  if (file !== ":memory:") fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Additive migrations for databases created by earlier versions.
  const pendingCols = (db.pragma("table_info(oauth_pending)") as { name: string }[]).map((c) => c.name);
  if (!pendingCols.includes("bind_hash")) db.exec("ALTER TABLE oauth_pending ADD COLUMN bind_hash TEXT");
  const now = () => new Date().toISOString();

  const stmts = {
    upsertItem: db.prepare(`
      INSERT INTO items (item_id, institution_id, institution_name)
      VALUES (@item_id, @institution_id, @institution_name)
      ON CONFLICT(item_id) DO UPDATE SET
        institution_id = COALESCE(excluded.institution_id, items.institution_id),
        institution_name = COALESCE(excluded.institution_name, items.institution_name)`),
    items: db.prepare(`SELECT * FROM items ORDER BY institution_name, created_at`),
    item: db.prepare(`SELECT * FROM items WHERE item_id = ?`),
    itemsByInstitution: db.prepare(`SELECT * FROM items WHERE institution_id = ? ORDER BY created_at`),
    setItemStatus: db.prepare(`UPDATE items SET status = ?, error_code = ? WHERE item_id = ?`),
    setCursor: db.prepare(`UPDATE items SET cursor = ?, last_synced_at = ?, status = 'ok', error_code = NULL WHERE item_id = ?`),
    deleteItem: db.prepare(`DELETE FROM items WHERE item_id = ?`),
    upsertAccount: db.prepare(`
      INSERT INTO accounts (account_id, item_id, name, official_name, mask, type, subtype, current, available, limit_amount, iso_currency_code, balance_updated_at)
      VALUES (@account_id, @item_id, @name, @official_name, @mask, @type, @subtype, @current, @available, @limit_amount, @iso_currency_code, @balance_updated_at)
      ON CONFLICT(account_id) DO UPDATE SET
        item_id = excluded.item_id, name = excluded.name, official_name = excluded.official_name,
        mask = excluded.mask, type = excluded.type, subtype = excluded.subtype,
        current = excluded.current, available = excluded.available, limit_amount = excluded.limit_amount,
        iso_currency_code = excluded.iso_currency_code, balance_updated_at = excluded.balance_updated_at`),
    accounts: db.prepare(`SELECT * FROM accounts ORDER BY item_id, name`),
    accountsForItem: db.prepare(`SELECT * FROM accounts WHERE item_id = ? ORDER BY name`),
    upsertTx: db.prepare(`
      INSERT INTO transactions (transaction_id, account_id, item_id, date, authorized_date, name, merchant_name, original_description,
        amount, iso_currency_code, pending, pending_transaction_id, category_primary, category_detailed, category_confidence, payment_channel, updated_at)
      VALUES (@transaction_id, @account_id, @item_id, @date, @authorized_date, @name, @merchant_name, @original_description,
        @amount, @iso_currency_code, @pending, @pending_transaction_id, @category_primary, @category_detailed, @category_confidence, @payment_channel, @updated_at)
      ON CONFLICT(transaction_id) DO UPDATE SET
        account_id = excluded.account_id, date = excluded.date, authorized_date = excluded.authorized_date, name = excluded.name,
        merchant_name = excluded.merchant_name, original_description = excluded.original_description, amount = excluded.amount,
        iso_currency_code = excluded.iso_currency_code, pending = excluded.pending, pending_transaction_id = excluded.pending_transaction_id,
        category_primary = excluded.category_primary, category_detailed = excluded.category_detailed,
        category_confidence = excluded.category_confidence, payment_channel = excluded.payment_channel, updated_at = excluded.updated_at`),
    deleteTx: db.prepare(`DELETE FROM transactions WHERE transaction_id = ?`),
    txCount: db.prepare(`SELECT COUNT(*) AS n FROM transactions`),
    upsertLiability: db.prepare(`
      INSERT INTO liabilities (account_id, item_id, kind, payload, updated_at)
      VALUES (@account_id, @item_id, @kind, @payload, @updated_at)
      ON CONFLICT(account_id) DO UPDATE SET item_id = excluded.item_id, kind = excluded.kind, payload = excluded.payload, updated_at = excluded.updated_at`),
    liabilities: db.prepare(`SELECT * FROM liabilities`),
  };

  return {
    raw: db,
    close: () => db.close(),

    upsertItem(row: { item_id: string; institution_id: string | null; institution_name: string | null }) {
      stmts.upsertItem.run(row);
    },
    items: () => stmts.items.all() as ItemRow[],
    item: (id: string) => stmts.item.get(id) as ItemRow | undefined,
    itemsByInstitution: (institutionId: string) => stmts.itemsByInstitution.all(institutionId) as ItemRow[],
    setItemStatus: (id: string, status: string, errorCode: string | null) => stmts.setItemStatus.run(status, errorCode, id),
    deleteItem: (id: string) => stmts.deleteItem.run(id),

    upsertAccounts(rows: Omit<AccountRow, never>[]) {
      const tx = db.transaction((rs: AccountRow[]) => rs.forEach((r) => stmts.upsertAccount.run(r)));
      tx(rows);
    },
    accounts: () => stmts.accounts.all() as AccountRow[],
    accountsForItem: (itemId: string) => stmts.accountsForItem.all(itemId) as AccountRow[],

    /**
     * Apply one complete /transactions/sync pass (all pages buffered) atomically:
     * removed -> delete; added+modified -> upsert; a posted transaction that
     * references a pending one replaces it; cursor saved in the same transaction.
     */
    applySync(itemId: string, batch: {
      added: Omit<TransactionRow, "updated_at">[];
      modified: Omit<TransactionRow, "updated_at">[];
      removed: string[];
      nextCursor: string;
    }): { added: number; modified: number; removed: number; replaced_pending: number } {
      const ts = now();
      let replaced = 0;
      const run = db.transaction(() => {
        for (const id of batch.removed) stmts.deleteTx.run(id);
        for (const t of [...batch.added, ...batch.modified]) {
          if (t.pending_transaction_id && !t.pending) {
            const r = stmts.deleteTx.run(t.pending_transaction_id);
            replaced += r.changes;
          }
          stmts.upsertTx.run({ ...t, updated_at: ts });
        }
        stmts.setCursor.run(batch.nextCursor, ts, itemId);
      });
      run();
      return { added: batch.added.length, modified: batch.modified.length, removed: batch.removed.length, replaced_pending: replaced };
    },

    transactions(opts: { start: string; end: string; mask?: string; itemId?: string }): (TransactionRow & { mask: string | null; account_name: string; institution_name: string | null })[] {
      const where = ["t.date >= @start", "t.date <= @end"];
      if (opts.mask) where.push("a.mask = @mask");
      if (opts.itemId) where.push("t.item_id = @itemId");
      return db
        .prepare(
          `SELECT t.*, a.mask AS mask, a.name AS account_name, i.institution_name
           FROM transactions t
           JOIN accounts a ON a.account_id = t.account_id
           JOIN items i ON i.item_id = t.item_id
           WHERE ${where.join(" AND ")}
           ORDER BY t.date ASC, a.mask ASC, t.transaction_id ASC`,
        )
        .all(opts) as never;
    },
    transactionCount: () => (stmts.txCount.get() as { n: number }).n,

    upsertLiabilities(rows: Omit<LiabilityRow, "updated_at">[]) {
      const ts = now();
      const tx = db.transaction((rs: typeof rows) => rs.forEach((r) => stmts.upsertLiability.run({ ...r, updated_at: ts })));
      tx(rows);
    },
    liabilities: () => stmts.liabilities.all() as LiabilityRow[],
  };
}
