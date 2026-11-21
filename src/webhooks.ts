import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import type { DB } from "./db.js";
import { plaid, describeError } from "./plaid.js";
import { syncItem, refreshAccounts } from "./sync.js";
import { refreshLiabilities } from "./liabilities.js";
import { finalizeLinkSession } from "./hosted-link.js";
import { log } from "./config.js";

// Plaid webhook receiver. Every request is verified with the Plaid-Verification
// JWT (ES256, key fetched by kid, body hash compared in constant time, max age
// 5 minutes). Webhooks are triggers only: on receipt we fetch current state
// from the API, never trust payload data. Work is queued so the HTTP response
// goes out immediately and items are processed one at a time.

const keyCache = new Map<string, { jwk: JWK; expired_at: number | null }>();

async function keyFor(kid: string): Promise<JWK> {
  const cached = keyCache.get(kid);
  if (cached && (cached.expired_at === null || cached.expired_at * 1000 > Date.now())) return cached.jwk;
  const res = await plaid().webhook.getVerificationKey({ key_id: kid });
  const k = res.key;
  const jwk: JWK = { kty: k.kty, crv: k.crv, x: k.x, y: k.y, alg: k.alg, use: k.use, kid: k.kid };
  keyCache.set(kid, { jwk, expired_at: k.expired_at ?? null });
  if (k.expired_at && k.expired_at * 1000 < Date.now()) throw new Error("verification key has expired");
  return jwk;
}

export async function verifyPlaidWebhook(rawBody: Buffer, jwt: string | undefined): Promise<void> {
  if (!jwt) throw new Error("missing Plaid-Verification header");
  const header = decodeProtectedHeader(jwt);
  if (header.alg !== "ES256" || !header.kid) throw new Error("unexpected JWT header");
  const key = await importJWK(await keyFor(header.kid), "ES256");
  const { payload } = await jwtVerify(jwt, key, { algorithms: ["ES256"], maxTokenAge: "5 minutes" });
  const claimed = String(payload.request_body_sha256 ?? "");
  const actual = createHash("sha256").update(rawBody).digest("hex");
  if (claimed.length !== actual.length || !timingSafeEqual(Buffer.from(claimed), Buffer.from(actual))) throw new Error("body hash mismatch");
}

export interface PlaidWebhookBody {
  webhook_type: string;
  webhook_code: string;
  item_id?: string;
  link_token?: string;
  error?: { error_code?: string } | null;
  [k: string]: unknown;
}

let queue: Promise<unknown> = Promise.resolve();
/** Serialize all webhook-triggered work (Plaid limits are per item; this is a laptop-sized service). */
export function enqueue(label: string, work: () => Promise<unknown>): void {
  queue = queue.then(work).catch((e) => log(`${label}: ${describeError(e)}`));
}

export function dispatchWebhook(db: DB, body: PlaidWebhookBody): void {
  const { webhook_type: type, webhook_code: code, item_id: itemId } = body;
  const label = `webhook ${type}/${code}${itemId ? ` ${itemId}` : ""}`;
  log(label);
  switch (type) {
    case "TRANSACTIONS":
      if (code === "SYNC_UPDATES_AVAILABLE" && itemId && db.item(itemId)) enqueue(label, () => syncItem(db, itemId));
      return;
    case "ITEM":
      if (!itemId || !db.item(itemId)) return;
      switch (code) {
        case "ERROR": {
          const ec = body.error?.error_code ?? "ERROR";
          db.setItemStatus(itemId, ec === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error", ec);
          return;
        }
        case "PENDING_DISCONNECT":
        case "PENDING_EXPIRATION":
          db.setItemStatus(itemId, "reauth_soon", code);
          return;
        case "LOGIN_REPAIRED":
          db.setItemStatus(itemId, "ok", null);
          enqueue(label, () => syncItem(db, itemId));
          return;
        case "USER_PERMISSION_REVOKED":
        case "USER_ACCOUNT_REVOKED":
          db.setItemStatus(itemId, "revoked", code);
          return;
        case "NEW_ACCOUNTS_AVAILABLE":
          enqueue(label, () => refreshAccounts(db, itemId));
          return;
        default:
          return; // WEBHOOK_UPDATE_ACKNOWLEDGED etc.
      }
    case "LIABILITIES":
      if (code === "DEFAULT_UPDATE" && itemId) enqueue(label, () => refreshLiabilities(db, itemId));
      return;
    case "LINK":
      if (code === "SESSION_FINISHED" && body.link_token) {
        const lt = body.link_token;
        enqueue(label, () => finalizeLinkSession(db, lt));
      }
      return;
    default:
      return;
  }
}
