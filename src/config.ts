import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

// Project root is one level above src/ (tsx) or dist/ (compiled). Resolving
// relative to this file means the MCP server works regardless of the cwd
// Claude Code launches it from.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadDotenv({ path: path.join(ROOT, ".env"), quiet: true });

export type PlaidEnvName = "sandbox" | "production";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env in ${ROOT} and fill it in (values are never printed).`,
    );
  }
  return v.trim();
}

function envName(): PlaidEnvName {
  const v = (process.env.PLAID_ENV ?? "sandbox").trim().toLowerCase();
  if (v === "sandbox" || v === "production") return v;
  throw new Error(`PLAID_ENV must be "sandbox" or "production" (got "${v}")`);
}

export const PLAID_ENV: PlaidEnvName = envName();

// Lazy getters so importing config never throws for commands that do not need keys.
export const plaidClientId = () => required("PLAID_CLIENT_ID");
// PLAID_SECRET_SANDBOX / PLAID_SECRET_PRODUCTION let both secrets live in .env so
// switching environments is only a PLAID_ENV change; PLAID_SECRET is the fallback.
export const plaidSecret = () => {
  const specific = process.env[`PLAID_SECRET_${PLAID_ENV.toUpperCase()}`]?.trim();
  return specific || required("PLAID_SECRET");
};

// How long a Hosted Link URL stays valid / how long `npm run link` waits for you (default 30 min).
export const LINK_TIMEOUT_SECONDS = Math.min(4 * 3600, Math.max(60, Number(process.env.LINK_TIMEOUT_SECONDS ?? 1800)));
export const TRANSACTION_DAYS = Math.min(730, Math.max(1, Number(process.env.TRANSACTION_DAYS ?? 365)));

// DATA_DIR can be overridden for hosted deployments (e.g. a mounted volume at /data).
export const DATA_DIR = process.env.DATA_DIR?.trim() || path.join(ROOT, "data");
export const EXPORT_DIR = process.env.EXPORT_DIR?.trim() || path.join(DATA_DIR === path.join(ROOT, "data") ? ROOT : DATA_DIR, "exports");
export const DB_PATH = path.join(DATA_DIR, `plaid-${PLAID_ENV}.db`);
export const ACCOUNTS_JSON = path.join(ROOT, "accounts.json");

// Keychain entries are namespaced per environment so sandbox and production
// tokens can never be mixed up (a token is only valid in the env that minted it).
export const KEYCHAIN_SERVICE = `plaid-mcp/${PLAID_ENV}`;

// ---- Hosted mode (src/http-server.ts) ----
// TOKEN_STORE: "keychain" (default on macOS) or "db" (AES-256-GCM encrypted column in
// SQLite, key from TOKEN_ENCRYPTION_KEY; default elsewhere, and what fly.toml sets).
export const TOKEN_STORE: "keychain" | "db" =
  (process.env.TOKEN_STORE?.trim() as "keychain" | "db" | undefined) ?? (process.platform === "darwin" ? "keychain" : "db");
export const tokenEncryptionKey = (): Buffer => {
  const raw = required("TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return key;
};
/** Name shown on Plaid's Link screen, the OAuth login page and the server's root. */
export const APP_NAME = (process.env.APP_NAME ?? "").trim() || "Finance MCP";
export const PORT = Number(process.env.PORT ?? 8080);
/** Public HTTPS origin of the hosted server, e.g. https://my-app.fly.dev (no trailing slash). */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").trim().replace(/\/$/, "");
export const WEBHOOK_URL = PUBLIC_URL ? `${PUBLIC_URL}/plaid/webhook` : undefined;
/**
 * Passphrase typed on the OAuth login page. Hosted mode refuses to start without it,
 * or with fewer than 8 characters; under 16 it logs a warning once.
 */
let passphraseChecked = false;
export const mcpPassphrase = () => {
  const p = required("MCP_PASSPHRASE");
  if (!passphraseChecked) {
    passphraseChecked = true;
    if (p.length < 8) throw new Error("MCP_PASSPHRASE must be at least 8 characters; 16 or more recommended");
    if (p.length < 16) log("warning: MCP_PASSPHRASE is shorter than 16 characters; it is the only credential protecting this server");
  }
  return p;
};
/** Set by the Fly runtime; when present the Fly-Client-IP header is trustworthy. */
export const ON_FLY = Boolean(process.env.FLY_APP_NAME);
/** Express trust-proxy setting: proxy hops in front of the app. Defaults to 1 on Fly and 0 anywhere else. */
export const TRUST_PROXY: number | boolean = (() => {
  const v = (process.env.TRUST_PROXY ?? (ON_FLY ? "1" : "0")).trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return Number.isFinite(Number(v)) ? Number(v) : 1;
})();
/**
 * Where an OAuth client may send authorization codes. Each comma-separated entry is either an exact
 * https URL (matched on origin + path, so an open redirect elsewhere on that host does not help an
 * attacker) or a bare loopback hostname (any port and path, for Claude Code's local callback).
 * Defaults cover claude.ai, claude.com and loopback.
 */
export const ALLOWED_REDIRECTS: string[] = (
  process.env.ALLOWED_REDIRECTS ?? "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,localhost,127.0.0.1,[::1]"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Hosted mode exposes the destructive `unlink` tool only when this is "true"; otherwise use the CLI. */
export const HOSTED_UNLINK = (process.env.HOSTED_UNLINK ?? "").trim().toLowerCase() === "true";

/** Log to stderr only. stdout is the MCP transport and must stay clean. */
export function log(...args: unknown[]): void {
  console.error(`[plaid-mcp ${new Date().toISOString()}]`, ...args);
}
