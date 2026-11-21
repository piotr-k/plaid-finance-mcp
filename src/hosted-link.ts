import type { Plaid } from "plaid";
import { APP_NAME, PLAID_ENV, TRANSACTION_DAYS, LINK_TIMEOUT_SECONDS, WEBHOOK_URL, log } from "./config.js";
import type { DB } from "./db.js";
import { storeAccessToken, readAccessToken, deleteAccessToken } from "./tokens.js";
import { plaid, describeError, COUNTRY_CODES } from "./plaid.js";
import { accountToRow, refreshAccounts, syncItem } from "./sync.js";

// Plaid Hosted Link: Plaid serves the Link UI on its own HTTPS domain and
// handles bank OAuth there, so no redirect URI and no local web page are
// needed. We create the link_token, hand the URL to the user, and later read
// the session's outcome from /link/token/get (triggered by the LINK webhook in
// hosted mode, or by polling from the CLI / scheduler).

export interface StartedLink {
  link_token: string;
  url: string;
  expiration: string;
  update_item_id?: string;
}

export async function startHostedLink(db: DB, opts: { updateItemId?: string } = {}): Promise<StartedLink> {
  const base: Plaid.LinkTokenCreateRequest = {
    client_name: APP_NAME,
    language: "en",
    country_codes: COUNTRY_CODES,
    user: { client_user_id: "household" },
    hosted_link: { url_lifetime_seconds: LINK_TIMEOUT_SECONDS },
    webhook: WEBHOOK_URL, // undefined locally; in hosted mode every new item reports here
  };
  const req: Plaid.LinkTokenCreateRequest = opts.updateItemId
    ? // Update mode: existing access_token, no products. No new public_token is issued.
      { ...base, access_token: readAccessToken(opts.updateItemId) }
    : {
        ...base,
        // transactions is the only hard requirement. liabilities is consented up
        // front but only fetched/billed when get_liabilities calls it, so banks
        // without Liabilities support still link.
        products: ["transactions"],
        additional_consented_products: ["liabilities"],
        transactions: { days_requested: TRANSACTION_DAYS },
      };
  const res = await plaid().link.createToken(req);
  if (!res.hosted_link_url) throw new Error("Plaid did not return a hosted_link_url");
  db.raw
    .prepare(`INSERT INTO link_sessions (link_token, update_item_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(res.link_token, opts.updateItemId ?? null, new Date().toISOString(), res.expiration);
  return { link_token: res.link_token, url: res.hosted_link_url, expiration: res.expiration, update_item_id: opts.updateItemId };
}

export interface LinkOutcome {
  status: "pending" | "linked" | "updated" | "duplicate" | "exit" | "empty" | "expired";
  message: string;
  items?: { item_id: string; institution: string | null; accounts: { name: string; mask: string | null; type: string; subtype: string | null }[]; first_sync: { added: number; status: string | null; error: string | null } }[];
}

interface PendingRow {
  created_at: string;
  link_token: string;
  update_item_id: string | null;
  expires_at: string;
  finished_at: string | null;
  result: string | null;
}

export function pendingLinkSessions(db: DB): PendingRow[] {
  return db.raw.prepare(`SELECT * FROM link_sessions WHERE finished_at IS NULL ORDER BY created_at`).all() as PendingRow[];
}

export function recentLinkSessions(db: DB, limit = 10): PendingRow[] {
  return db.raw.prepare(`SELECT * FROM link_sessions ORDER BY created_at DESC LIMIT ?`).all(limit) as PendingRow[];
}

function finish(db: DB, linkToken: string, outcome: LinkOutcome) {
  db.raw.prepare(`UPDATE link_sessions SET finished_at = ?, result = ? WHERE link_token = ?`).run(new Date().toISOString(), JSON.stringify(outcome), linkToken);
  return outcome;
}

/**
 * Read a Hosted Link session's outcome and, if an account was added, exchange
 * the public_token(s), store the access_token, record the item and run the
 * first sync. Safe to call repeatedly: a finished session is not processed twice.
 */
export async function finalizeLinkSession(db: DB, linkToken: string): Promise<LinkOutcome> {
  const row = db.raw.prepare(`SELECT * FROM link_sessions WHERE link_token = ?`).get(linkToken) as PendingRow | undefined;
  if (!row) return { status: "empty", message: "unknown link session" };
  if (row.finished_at && row.result) return JSON.parse(row.result) as LinkOutcome;

  const res = await plaid().link.getToken({ link_token: linkToken });
  const session = res.link_sessions?.find((s) => s.results?.item_add_results?.length || s.on_success || s.exit?.error || s.finished_at);
  if (!session) {
    if (new Date(row.expires_at).getTime() < Date.now()) return finish(db, linkToken, { status: "expired", message: "Link URL expired before it was used" });
    return { status: "pending", message: "waiting for the Link session to finish" };
  }
  if (session.exit?.error) {
    const e = session.exit.error;
    return finish(db, linkToken, { status: "exit", message: `Link exited with ${e.error_type}/${e.error_code}: ${e.display_message ?? e.error_message} (link_session_id ${session.link_session_id})` });
  }

  if (row.update_item_id) {
    db.setItemStatus(row.update_item_id, "ok", null);
    const r = await syncItem(db, row.update_item_id);
    return finish(db, linkToken, {
      status: r.error ? "exit" : "updated",
      message: r.error ? `re-authenticated but sync failed: ${r.error}` : `re-authenticated ${row.update_item_id}; sync +${r.added} ~${r.modified} -${r.removed}`,
    });
  }

  const results = session.results?.item_add_results ?? [];
  const added = results.length
    ? results
    : session.on_success
      ? [{ public_token: session.on_success.public_token, institution: session.on_success.metadata?.institution ?? null, accounts: session.on_success.metadata?.accounts ?? [] }]
      : [];
  if (!added.length) return finish(db, linkToken, { status: "empty", message: `Link finished without adding an account (link_session_id ${session.link_session_id})` });

  const items: NonNullable<LinkOutcome["items"]> = [];
  const notes: string[] = [];
  for (const r of added) {
    const instId = r.institution?.institution_id ?? null;
    const instLabel = r.institution?.name ?? instId ?? "unknown institution";
    // Exchange first (the Item already exists at Plaid and is billed either way).
    // Then decide whether it duplicates an Item we already hold (ITEM-001/011):
    // same institution alone is fine (a second person's login), but if any
    // account mask is already present under an existing Item at that
    // institution, this is the same login linked twice, so remove the new Item.
    const ex = await plaid().item.exchangePublicToken({ public_token: r.public_token });
    const newAccounts = (await plaid().accounts.get({ access_token: ex.access_token })).accounts.map((a) => accountToRow(ex.item_id, a));
    const newMasks = newAccounts.map((a) => a.mask);
    const siblings = instId ? db.itemsByInstitution(instId) : [];
    const dup = findDuplicate(
      siblings.map((s) => ({ item_id: s.item_id, masks: db.accountsForItem(s.item_id).map((a) => a.mask) })),
      newMasks,
    );
    if (dup) {
      log(`duplicate check: ${instLabel} item ${ex.item_id} shares mask(s) ${dup.masks.join(",")} with existing item ${dup.item_id}; removing new item`);
      try {
        await plaid().item.remove({ access_token: ex.access_token });
      } catch (e) {
        log(`item/remove of duplicate ${ex.item_id} failed: ${describeError(e)}`);
      }
      notes.push(`${instLabel} accounts ending ${dup.masks.join(", ")} are already linked as ${dup.item_id}; the new connection was removed. To repair a broken login use start_link with update_item_id=${dup.item_id}.`);
      continue;
    }
    if (siblings.length) {
      log(`duplicate check: ${instLabel} already linked as ${siblings.map((s) => s.item_id).join(",")} but masks [${newMasks.filter(Boolean).join(",")}] do not overlap; keeping new item ${ex.item_id}`);
    } else {
      log(`duplicate check: ${instLabel} not linked before; keeping new item ${ex.item_id}`);
    }
    storeAccessToken(ex.item_id, ex.access_token); // encrypted store / Keychain only; never logged
    let instName = r.institution?.name ?? null;
    if (instId) {
      try {
        instName = (await plaid().institutions.getById({ institution_id: instId, country_codes: COUNTRY_CODES })).institution.name;
      } catch { /* keep Link's name */ }
    }
    db.upsertItem({ item_id: ex.item_id, institution_id: instId, institution_name: instName });
    log(`linked ${instName} as item ${ex.item_id} (${PLAID_ENV}, link_session_id ${session.link_session_id}, request_id ${ex.request_id})`);
    const accounts = await refreshAccounts(db, ex.item_id);
    const sync = await syncItem(db, ex.item_id); // first sync; enables Plaid-side updates + webhooks for the item
    items.push({
      item_id: ex.item_id,
      institution: instName,
      accounts: accounts.map((a) => ({ name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })),
      first_sync: { added: sync.added, status: sync.update_status, error: sync.error },
    });
  }
  if (!items.length) return finish(db, linkToken, { status: "duplicate", message: notes.join(" ") });
  return finish(db, linkToken, {
    status: "linked",
    message: [`linked ${items.map((i) => i.institution).join(", ")}`, ...notes].join(" "),
    items,
  });
}

/**
 * Duplicate check for a freshly linked Item. A second login at the same
 * institution (another household member's own account) is legitimate, so institution
 * alone is not enough: the new Item is a duplicate only when at least one of
 * its account masks also belongs to an existing Item at that institution.
 * Accounts without a mask cannot be compared and never count as overlap.
 * Returns the matching existing item and the shared masks, or null.
 */
export function findDuplicate(
  existing: Array<{ item_id: string; masks: Array<string | null> }>,
  newMasks: Array<string | null>,
): { item_id: string; masks: string[] } | null {
  const mine = new Set(newMasks.filter((m): m is string => !!m));
  for (const item of existing) {
    const shared = [...new Set(item.masks.filter((m): m is string => !!m && mine.has(m)))].sort();
    if (shared.length) return { item_id: item.item_id, masks: shared };
  }
  return null;
}

/** Finalize every unfinished session (fallback when the LINK webhook is missed). */
export async function finalizePendingLinkSessions(db: DB): Promise<LinkOutcome[]> {
  const out: LinkOutcome[] = [];
  for (const p of pendingLinkSessions(db)) {
    try {
      out.push(await finalizeLinkSession(db, p.link_token));
    } catch (e) {
      log(`finalize ${p.link_token.slice(0, 12)}…: ${describeError(e)}`);
    }
  }
  return out;
}

/** Remove a linked item everywhere: Plaid (/item/remove), token store, local rows. */
export async function unlinkItem(db: DB, itemId: string): Promise<string> {
  let note = "";
  try {
    await plaid().item.remove({ access_token: readAccessToken(itemId) });
  } catch (e) {
    note = ` (item/remove: ${describeError(e)}; local copy removed anyway)`;
  }
  deleteAccessToken(itemId);
  db.deleteItem(itemId);
  return `unlinked ${itemId}${note}`;
}
