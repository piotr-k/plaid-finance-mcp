import { PlaidClient, PlaidEnvironment, type Plaid } from "plaid";
import { PLAID_ENV, plaidClientId, plaidSecret, log } from "./config.js";

// One client, one source of truth for environment + keys (.env). Tokens are
// only valid in the environment that minted them, so PLAID_ENV also selects
// the SQLite file and the Keychain service name (see config.ts).
let client: PlaidClient | null = null;
export function plaid(): PlaidClient {
  if (!client) {
    client = new PlaidClient({
      environment: PLAID_ENV === "production" ? PlaidEnvironment.Production : PlaidEnvironment.Sandbox,
      clientId: plaidClientId(),
      secret: plaidSecret(),
      // /accounts/balance/get and the first sync after a historical backfill can be slow.
      timeoutInSeconds: 90,
      maxRetries: 0, // we do our own, below, so we can branch on error_code
    });
  }
  return client;
}

export interface PlaidErr {
  error_type: string;
  error_code: string;
  display_message: string | null;
  request_id?: string;
  status?: number;
}

/** Extract Plaid's structured error from an SDK exception, or null if it is something else. */
export function plaidError(err: unknown): PlaidErr | null {
  const body = (err as { body?: unknown })?.body as Partial<Plaid.PlaidError> | undefined;
  if (body && typeof body === "object" && typeof body.error_code === "string") {
    return {
      error_type: String(body.error_type),
      error_code: body.error_code,
      display_message: body.display_message ?? null,
      request_id: body.request_id,
      status: (err as { statusCode?: number }).statusCode,
    };
  }
  return null;
}

/** Safe-to-show summary: never includes tokens or secrets. */
export function describeError(err: unknown): string {
  const pe = plaidError(err);
  if (pe) return `${pe.error_type}/${pe.error_code}${pe.request_id ? ` (request_id ${pe.request_id})` : ""}`;
  return err instanceof Error ? err.message : String(err);
}

const RETRYABLE = new Set(["INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING", "PRODUCT_NOT_READY", "INTERNAL_SERVER_ERROR"]);

/** Needs the user to act (re-link / unlock); retrying cannot help. */
export const NEEDS_USER = new Set(["ITEM_LOGIN_REQUIRED", "INVALID_CREDENTIALS", "ITEM_LOCKED", "ACCESS_NOT_GRANTED", "ITEM_NOT_FOUND", "ADDITIONAL_CONSENT_REQUIRED"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Capped exponential backoff with jitter for transient Plaid errors and rate limits. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 1500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const pe = plaidError(err);
      const transient = pe ? pe.error_type === "RATE_LIMIT_EXCEEDED" || RETRYABLE.has(pe.error_code) : false;
      if (!transient || i >= attempts) throw err;
      const wait = delay + Math.floor(Math.random() * 500);
      log(`${label}: ${describeError(err)}; retry ${i}/${attempts - 1} in ${wait}ms`);
      await sleep(wait);
      delay = Math.min(delay * 2, 20_000);
    }
  }
}

export const COUNTRY_CODES: Plaid.CountryCode[] = ["US"];
