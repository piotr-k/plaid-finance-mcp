import type { Plaid } from "plaid";
import type { DB, AccountRow, TransactionRow } from "./db.js";
import { readAccessToken } from "./tokens.js";
import { plaid, withRetry, plaidError, describeError, NEEDS_USER } from "./plaid.js";
import { log } from "./config.js";

export interface SyncResult {
  item_id: string;
  institution: string | null;
  added: number;
  modified: number;
  removed: number;
  replaced_pending: number;
  update_status: string | null;
  error: string | null;
}

function toRow(itemId: string, t: Plaid.Transaction): Omit<TransactionRow, "updated_at"> {
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    item_id: itemId,
    date: t.date,
    authorized_date: t.authorized_date ?? null,
    name: t.name,
    merchant_name: t.merchant_name ?? null,
    original_description: t.original_description ?? null,
    amount: t.amount,
    iso_currency_code: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
    pending: t.pending ? 1 : 0,
    pending_transaction_id: t.pending_transaction_id ?? null,
    category_primary: t.personal_finance_category?.primary ?? null,
    category_detailed: t.personal_finance_category?.detailed ?? null,
    category_confidence: t.personal_finance_category?.confidence_level ?? null,
    payment_channel: t.payment_channel ?? null,
  };
}

export function accountToRow(itemId: string, a: Plaid.AccountBase): AccountRow {
  return {
    account_id: a.account_id,
    item_id: itemId,
    name: a.name,
    official_name: a.official_name ?? null,
    mask: a.mask ?? null,
    type: String(a.type),
    subtype: a.subtype ? String(a.subtype) : null,
    current: a.balances.current ?? null,
    available: a.balances.available ?? null,
    limit_amount: a.balances.limit ?? null,
    iso_currency_code: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? null,
    balance_updated_at: a.balances.last_updated_datetime ?? new Date().toISOString(),
  };
}

/** Refresh the account list + cached balances from /accounts/get (free, authoritative). */
export async function refreshAccounts(db: DB, itemId: string): Promise<AccountRow[]> {
  const accessToken = readAccessToken(itemId);
  const res = await withRetry(`accounts/get ${itemId}`, () => plaid().accounts.get({ access_token: accessToken }));
  const rows = res.accounts.map((a) => accountToRow(itemId, a));
  db.upsertAccounts(rows);
  return rows;
}

/**
 * Run /transactions/sync for one item. Pages are buffered in memory and
 * written together with the cursor in one SQLite transaction, so an
 * interrupted run never persists a mid-pagination cursor. A
 * TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION error restarts from the
 * cursor the pass began with.
 */
export async function syncItem(db: DB, itemId: string): Promise<SyncResult> {
  const item = db.item(itemId);
  const base: SyncResult = {
    item_id: itemId,
    institution: item?.institution_name ?? null,
    added: 0,
    modified: 0,
    removed: 0,
    replaced_pending: 0,
    update_status: null,
    error: null,
  };
  let accessToken: string;
  try {
    accessToken = readAccessToken(itemId);
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }

  const startCursor = item?.cursor ?? "";
  for (let pass = 1; pass <= 3; pass++) {
    const added: Plaid.Transaction[] = [];
    const modified: Plaid.Transaction[] = [];
    const removed: string[] = [];
    let cursor = startCursor;
    let status: string | null = null;
    try {
      for (;;) {
        const res: Plaid.TransactionsSyncResponse = await withRetry(`transactions/sync ${itemId}`, () =>
          plaid().transactions.sync({
            access_token: accessToken,
            cursor: cursor || undefined,
            count: 500,
            options: { include_original_description: true },
          }),
        );
        added.push(...res.added);
        modified.push(...res.modified);
        removed.push(...res.removed.map((r) => r.transaction_id));
        status = res.transactions_update_status ?? null;
        cursor = res.next_cursor;
        if (!res.has_more) break;
      }
    } catch (err) {
      const pe = plaidError(err);
      if (pe?.error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && pass < 3) {
        log(`${itemId}: data changed mid-pagination, restarting pass ${pass + 1}`);
        continue;
      }
      if (pe && NEEDS_USER.has(pe.error_code)) db.setItemStatus(itemId, "login_required", pe.error_code);
      else if (pe) db.setItemStatus(itemId, "error", pe.error_code);
      return { ...base, error: describeError(err) };
    }

    // Account rows must exist before transactions reference them in queries.
    try {
      await refreshAccounts(db, itemId);
    } catch (err) {
      log(`${itemId}: accounts/get failed, keeping cached accounts: ${describeError(err)}`);
    }

    const counts = db.applySync(itemId, {
      added: added.map((t) => toRow(itemId, t)),
      modified: modified.map((t) => toRow(itemId, t)),
      removed,
      nextCursor: cursor,
    });
    return { ...base, ...counts, update_status: status };
  }
  return { ...base, error: "gave up after repeated mid-pagination mutations" };
}

export async function syncAll(db: DB): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  // Sequential on purpose: Plaid rate limits are per item/endpoint and this is a laptop.
  for (const item of db.items()) out.push(await syncItem(db, item.item_id));
  return out;
}
