import fs from "node:fs";
import { ACCOUNTS_JSON } from "./config.js";

/**
 * Optional accounts.json: maps a last-4 mask to a friendly name, or to an
 * object with extra hand-maintained facts Plaid does not provide.
 *
 *   { "1234": "Checking", "9012": { "name": "Rewards Card", "promo_end": "2027-06-30" } }
 */
export interface AccountMeta {
  name?: string;
  promo_end?: string;
}

let cache: Record<string, AccountMeta> | null = null;

export function accountMeta(mask: string | null | undefined): AccountMeta {
  if (!mask) return {};
  if (cache === null) {
    cache = {};
    if (fs.existsSync(ACCOUNTS_JSON)) {
      const raw = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, "utf8")) as Record<string, string | AccountMeta>;
      for (const [k, v] of Object.entries(raw)) {
        cache[k] = typeof v === "string" ? { name: v } : v;
      }
    }
  }
  return cache[mask] ?? {};
}

export function friendlyName(mask: string | null | undefined, fallback: string): string {
  return accountMeta(mask).name ?? fallback;
}
