import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import type { DB } from "./db.js";
import { plaid, plaidError, describeError } from "./plaid.js";
import { syncItem, refreshAccounts } from "./sync.js";
import { refreshLiabilities } from "./liabilities.js";
import { finalizeLinkSession } from "./hosted-link.js";
import { log } from "./config.js";

// Plaid webhook receiver. Every request is verified with the Plaid-Verification
// JWT (ES256, key fetched by kid, body hash compared in constant time, max age
// 5 minutes). Webhooks are triggers only: on receipt we fetch current state
// from the API, never trust payload data. Work is queued so the HTTP response
// goes out immediately and items are processed one at a time.
//
// The endpoint is public, so the key lookup is the one thing an anonymous
// sender can make us do. It is bounded: kids must look like kids, failed and
// expired kids are negative-cached (transient failures are not, so a hiccup can never
// lock out Plaid's real key), concurrent lookups for one kid share a single request,
// and uncached lookups are limited per minute.

const KID = /^[A-Za-z0-9_-]{1,128}$/;
const TRANSIENT = new Set(["RATE_LIMIT_EXCEEDED", "INTERNAL_SERVER_ERROR", "PLANNED_MAINTENANCE"]);
const NEGATIVE_TTL_MS = 10 * 60_000;
const MAX_CACHE = 64;
const LOOKUPS_PER_MINUTE = 20;

const keyCache = new Map<string, { jwk: JWK; expired_at: number | null }>();
const negativeCache = new Map<string, number>(); // kid -> until (ms)
const inFlight = new Map<string, Promise<JWK>>();
let bucket = { tokens: LOOKUPS_PER_MINUTE, refilled: Date.now() };

function takeLookupToken(): boolean {
  const t = Date.now();
  const refill = Math.floor((t - bucket.refilled) / 60_000) * LOOKUPS_PER_MINUTE;
  if (refill > 0) bucket = { tokens: Math.min(LOOKUPS_PER_MINUTE, bucket.tokens + refill), refilled: t };
  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

function bound<K, V>(m: Map<K, V>) {
  while (m.size > MAX_CACHE) m.delete(m.keys().next().value as K);
}

async function fetchKey(kid: string): Promise<JWK> {
  if (!takeLookupToken()) throw new Error("verification key lookups are rate-limited; try again later");
  try {
    const res = await plaid().webhook.getVerificationKey({ key_id: kid });
    const k = res.key;
    const jwk: JWK = { kty: k.kty, crv: k.crv, x: k.x, y: k.y, alg: k.alg, use: k.use, kid: k.kid };
    const expiredAt = k.expired_at ?? null;
    if (expiredAt && expiredAt * 1000 < Date.now()) {
      negativeCache.set(kid, Date.now() + NEGATIVE_TTL_MS);
      throw new Error("verification key has expired");
    }
    keyCache.set(kid, { jwk, expired_at: expiredAt });
    bound(keyCache);
    return jwk;
  } catch (e) {
    // Only a definitive answer from Plaid ("no such key", invalid input, or the expiry above)
    // is remembered. Network errors, 5xx and rate limits are transient: caching them would let
    // an outage or a burst of junk requests block Plaid's real key for ten minutes.
    const pe = plaidError(e);
    const definitive = (e instanceof Error && e.message === "verification key has expired") || (pe !== null && !TRANSIENT.has(pe.error_code) && pe.error_type !== "API_ERROR");
    if (definitive) {
      negativeCache.set(kid, Date.now() + NEGATIVE_TTL_MS);
      bound(negativeCache);
    }
    throw e;
  }
}

async function keyFor(kid: string): Promise<JWK> {
  const cached = keyCache.get(kid);
  if (cached) {
    if (cached.expired_at === null || cached.expired_at * 1000 > Date.now()) return cached.jwk;
    keyCache.delete(kid);
    negativeCache.set(kid, Date.now() + NEGATIVE_TTL_MS);
  }
  const until = negativeCache.get(kid);
  if (until && until > Date.now()) throw new Error("unknown or expired verification key (cached)");
  negativeCache.delete(kid);
  let p = inFlight.get(kid);
  if (!p) {
    p = fetchKey(kid).finally(() => inFlight.delete(kid));
    inFlight.set(kid, p);
  }
  return p;
}

/** Test hook: forget cached keys, negative entries and the lookup budget. */
export function resetWebhookState(): void {
  keyCache.clear();
  negativeCache.clear();
  inFlight.clear();
  bucket = { tokens: LOOKUPS_PER_MINUTE, refilled: Date.now() };
}

export async function verifyPlaidWebhook(rawBody: unknown, jwt: string | undefined): Promise<void> {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) throw new Error("empty or non-raw body");
  if (!jwt || jwt.length > 4096) throw new Error("missing or oversized Plaid-Verification header");
  const header = decodeProtectedHeader(jwt);
  if (header.alg !== "ES256" || typeof header.kid !== "string" || !KID.test(header.kid)) throw new Error("unexpected JWT header");
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
