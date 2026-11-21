import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import express from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidClientError, InvalidClientMetadataError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { DB } from "./db.js";
import { APP_NAME, ALLOWED_REDIRECTS, ON_FLY, PUBLIC_URL, mcpPassphrase, log } from "./config.js";

// A minimal OAuth 2.1 authorization server for exactly one human: you.
// Clients (claude.ai, Claude Code) register dynamically, start the PKCE flow,
// and land on /login, where the only credential is the passphrase in
// MCP_PASSPHRASE. Codes and tokens are random, stored hashed in SQLite.
//
// Three things keep a stranger from turning that passphrase into their own
// tokens: registration only accepts redirect_uris matching ALLOWED_REDIRECTS;
// the login page names the client and the exact address it will send the code
// to; and a pending request is bound to the browser that started it with an
// HttpOnly cookie set at /authorize, so a forwarded /login link cannot be
// completed by anyone else, whatever the relying party does with `state`.

const ACCESS_TTL_S = 30 * 24 * 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const CODE_TTL_S = 10 * 60;
const PENDING_TTL_S = 15 * 60;
// Login throttling: all three windows are 15 minutes and all counters live in SQLite,
// so a restart does not reset them.
const FAIL_WINDOW_S = 15 * 60;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 60; // high enough that locking the owner out needs many addresses, low enough to make guessing pointless
const MAX_FAILS_PER_REQUEST = 3;
export const BIND_COOKIE = "mcp_authorize";
export const SCOPES = ["finance:read", "finance:link"];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MAX_CLIENT_NAME = 100;

/**
 * Is this redirect_uri acceptable for a client of this server? Loopback entries match any port and
 * path over http or https; every other entry must match the URL's origin and path exactly (query and
 * fragment are not allowed), so only the registered callback on that host can receive a code.
 */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase(); // IPv6 literals come back bracketed already
  if (LOOPBACK.has(host)) return ALLOWED_REDIRECTS.some((e) => e.toLowerCase() === host) && (u.protocol === "http:" || u.protocol === "https:");
  if (u.protocol !== "https:" || u.search || u.hash) return false;
  const exact = u.origin.toLowerCase() + u.pathname;
  return ALLOWED_REDIRECTS.some((e) => {
    try {
      const a = new URL(e);
      return a.protocol === "https:" && a.origin.toLowerCase() + a.pathname === exact;
    } catch {
      return false;
    }
  });
}

type Pending = AuthorizationParams & { clientId: string };

export interface PendingInfo {
  client_name: string;
  redirect_to: string; // origin + path the code will be sent to
  scopes: string[];
}

export class SqliteOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private db: DB) {
    const raw = db.raw;
    this.clientsStore = {
      getClient(clientId) {
        const row = raw.prepare(`SELECT data FROM oauth_clients WHERE client_id = ?`).get(clientId) as { data: string } | undefined;
        return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
      },
      registerClient(client) {
        const full = { ...(client as OAuthClientInformationFull) };
        const uris = full.redirect_uris ?? [];
        if (!uris.length) throw new InvalidClientMetadataError("redirect_uris is required");
        if (typeof full.client_name === "string" && full.client_name.length > MAX_CLIENT_NAME) throw new InvalidClientMetadataError(`client_name must be at most ${MAX_CLIENT_NAME} characters`);
        const bad = uris.filter((u) => !redirectUriAllowed(u));
        if (bad.length) {
          log(`oauth: rejected registration (${full.client_name ?? "unnamed"}): redirect host not allowed: ${bad.map((u) => safeHost(u)).join(",")}`);
          throw new InvalidClientMetadataError(`redirect_uri not allowed; permitted: ${ALLOWED_REDIRECTS.join(", ")}`);
        }
        full.client_id ||= randomUUID();
        full.client_id_issued_at ||= now();
        raw.prepare(`INSERT INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)`).run(full.client_id, JSON.stringify(full), new Date().toISOString());
        log(`oauth: registered client ${full.client_id} (${full.client_name ?? "unnamed"}) redirect_uris=${uris.join(",")}`);
        return full;
      },
    };
  }

  /** Step 1: park the request and send the user to the login page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // The SDK already checks redirect_uri against the client's registration; this keeps a
    // client registered under an older allowlist from using a now-disallowed URL. Answer
    // directly: throwing here would make the SDK redirect the error to that very URL.
    if (!redirectUriAllowed(params.redirectUri)) {
      log(`oauth: refused authorize for client ${client.client_id}: redirect_uri not allowed (${safeHost(params.redirectUri)})`);
      res.status(400).type("html").send(PAGE(`<p class="err">This client's redirect address is not allowed by this server.</p>`));
      return;
    }
    const id = token();
    const bind = token(); // only ever lives in this browser's cookie jar; the DB keeps its hash
    const pending: Pending = { ...params, clientId: client.client_id, resource: params.resource };
    this.db.raw
      .prepare(`INSERT INTO oauth_pending (id, client_id, params, expires_at, bind_hash) VALUES (?, ?, ?, ?, ?)`)
      .run(id, client.client_id, JSON.stringify({ ...pending, resource: params.resource?.toString() }), now() + PENDING_TTL_S, sha256(bind));
    res.cookie(BIND_COOKIE, bind, { httpOnly: true, sameSite: "lax", secure: PUBLIC_URL.startsWith("https://"), path: "/login", maxAge: PENDING_TTL_S * 1000 });
    res.redirect(302, `/login?req=${encodeURIComponent(id)}`);
  }

  /** Does this browser hold the cookie that /authorize set for this pending request? */
  bindMatches(reqId: string, bind: string | undefined): boolean {
    if (!bind || bind.length > 128) return false;
    const row = this.db.raw.prepare(`SELECT bind_hash FROM oauth_pending WHERE id = ?`).get(reqId) as { bind_hash: string | null } | undefined;
    if (!row?.bind_hash) return false;
    const a = Buffer.from(sha256(bind));
    const b = Buffer.from(row.bind_hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** What the login page shows so the owner can recognise (or refuse) the request. */
  pendingInfo(reqId: string): PendingInfo | null {
    const row = this.db.raw.prepare(`SELECT client_id, params, expires_at FROM oauth_pending WHERE id = ?`).get(reqId) as
      | { client_id: string; params: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now()) return null;
    const p = JSON.parse(row.params) as Pending;
    const client = this.clientsStore.getClient(row.client_id) as OAuthClientInformationFull | undefined;
    return { client_name: client?.client_name ?? "unnamed client", redirect_to: safeTarget(p.redirectUri), scopes: p.scopes ?? SCOPES };
  }

  private failures(where: string, arg: string | number): number {
    return (this.db.raw.prepare(`SELECT COUNT(*) AS n FROM login_failures WHERE ts > ? AND ${where}`).get(now() - FAIL_WINDOW_S, arg) as { n: number }).n;
  }

  /** Step 2 (called from the /login POST): passphrase ok → issue a code and redirect back to the client. */
  completeLogin(reqId: string, ip: string, passphrase: string): { redirect: string } | { error: string; status: number } {
    if (this.failures("ip = ?", ip) >= MAX_FAILS_PER_IP || this.failures("1 = ?", 1) >= MAX_FAILS_GLOBAL) {
      return { error: "Too many attempts. Try again in 15 minutes.", status: 429 };
    }
    const row = this.db.raw.prepare(`SELECT client_id, params, expires_at FROM oauth_pending WHERE id = ?`).get(reqId) as
      | { client_id: string; params: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now()) return { error: "This sign-in link has expired. Start again from Claude.", status: 400 };
    const expected = Buffer.from(mcpPassphrase());
    const given = Buffer.from(passphrase);
    const ok = expected.length === given.length && timingSafeEqual(expected, given);
    if (!ok) {
      this.db.raw.prepare(`INSERT INTO login_failures (ts, ip, req_id) VALUES (?, ?, ?)`).run(now(), ip, reqId);
      log(`oauth: wrong passphrase from ${ip}`);
      if (this.failures("req_id = ?", reqId) >= MAX_FAILS_PER_REQUEST) {
        this.db.raw.prepare(`DELETE FROM oauth_pending WHERE id = ?`).run(reqId); // burn the request; the client must start over
        return { error: "Too many wrong attempts for this sign-in. Start again from Claude.", status: 400 };
      }
      return { error: "Wrong passphrase.", status: 401 };
    }
    const p = JSON.parse(row.params) as Pending & { resource?: string };
    const code = token();
    this.db.raw
      .prepare(`INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256(code), row.client_id, p.codeChallenge, p.redirectUri, (p.scopes ?? SCOPES).join(" "), p.resource ?? null, now() + CODE_TTL_S);
    this.db.raw.prepare(`DELETE FROM oauth_pending WHERE id = ?`).run(reqId);
    const url = new URL(p.redirectUri);
    url.searchParams.set("code", code);
    if (p.state) url.searchParams.set("state", p.state);
    log(`oauth: issued code to client ${row.client_id}`);
    return { redirect: url.toString() };
  }

  private codeRow(code: string) {
    return this.db.raw.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).get(sha256(code)) as
      | { code_hash: string; client_id: string; code_challenge: string; redirect_uri: string; scopes: string | null; resource: string | null; expires_at: number }
      | undefined;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.codeRow(authorizationCode);
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return row.code_challenge;
  }

  private issue(clientId: string, scopes: string[], resource: string | null): OAuthTokens {
    const access = token();
    const refresh = token();
    const ts = new Date().toISOString();
    const ins = this.db.raw.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.db.raw.transaction(() => {
      ins.run(sha256(access), "access", clientId, scopes.join(" "), resource, now() + ACCESS_TTL_S, ts);
      ins.run(sha256(refresh), "refresh", clientId, scopes.join(" "), resource, now() + REFRESH_TTL_S, ts);
    })();
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const row = this.codeRow(authorizationCode);
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    this.db.raw.prepare(`DELETE FROM oauth_codes WHERE code_hash = ?`).run(row.code_hash); // single use
    return this.issue(client.client_id, (row.scopes ?? "").split(" ").filter(Boolean), resource?.toString() ?? row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const h = sha256(refreshToken);
    const row = this.db.raw.prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`).get(h) as
      | { client_id: string; scopes: string | null; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now()) throw new InvalidGrantError("Invalid or expired refresh token");
    if (row.client_id !== client.client_id) throw new InvalidClientError("refresh token belongs to another client");
    this.db.raw.prepare(`DELETE FROM oauth_tokens WHERE token_hash = ?`).run(h); // rotate
    const granted = (row.scopes ?? "").split(" ").filter(Boolean);
    const want = scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted;
    return this.issue(client.client_id, want, resource?.toString() ?? row.resource);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const row = this.db.raw.prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`).get(sha256(accessToken)) as
      | { client_id: string; scopes: string | null; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now()) throw new InvalidTokenError("invalid or expired token");
    return { token: accessToken, clientId: row.client_id, scopes: (row.scopes ?? "").split(" ").filter(Boolean), expiresAt: row.expires_at, resource: row.resource ? new URL(row.resource) : undefined };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.db.raw.prepare(`DELETE FROM oauth_tokens WHERE token_hash = ?`).run(sha256(request.token));
  }

  /** Drop expired codes, pending requests, tokens and old failure records. */
  cleanup(): void {
    const t = now();
    this.db.raw.prepare(`DELETE FROM oauth_pending WHERE expires_at < ?`).run(t);
    this.db.raw.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).run(t);
    this.db.raw.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`).run(t);
    this.db.raw.prepare(`DELETE FROM login_failures WHERE ts < ?`).run(t - FAIL_WINDOW_S);
  }
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "invalid-url";
  }
}
/** origin + path only: enough to recognise the callback, no query noise. */
function safeTarget(uri: string): string {
  try {
    const u = new URL(uri);
    return u.origin + u.pathname;
  } catch {
    return "invalid-url";
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PAGE = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · ${esc(APP_NAME)}</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 20px;color:#111}
input{font:inherit;width:100%;padding:10px 12px;border:1px solid #bbb;border-radius:8px;box-sizing:border-box}
button{font:inherit;margin-top:12px;padding:10px 18px;border-radius:8px;border:0;background:#111;color:#fff;width:100%}
.err{color:#b00020;margin:8px 0}.who{background:#f3f3f3;border-radius:8px;padding:10px 12px;margin:12px 0}.who b{display:block}</style></head><body>${body}</body></html>`;

/** The client IP for throttling: the Fly header only on Fly, otherwise what Express derived via trust proxy. */
export function clientIp(req: Request): string {
  const fly = req.headers["fly-client-ip"];
  if (ON_FLY && typeof fly === "string" && fly) return fly;
  return req.ip ?? "unknown";
}

const REQ_ID = /^[A-Za-z0-9_-]{20,64}$/;
const FAIL_DELAY_MS = 400;

/** Minimal cookie header parser (no cookie-parser dependency needed for one cookie). */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Express routes for the login page used by SqliteOAuthProvider.authorize. */
export function loginRouter(provider: SqliteOAuthProvider): Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  const headers = (res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
  };
  const form = (reqId: string, info: PendingInfo, err = "") =>
    PAGE(`<h2>${esc(APP_NAME)}</h2>
    <div class="who"><b>${esc(info.client_name)}</b>wants access to your bank data (${esc(info.scopes.join(", "))}).<br>After you allow it, the sign-in code is sent to <b>${esc(info.redirect_to)}</b>.</div>
    <p>If you did not just start this from Claude, close this page.</p>
    ${err ? `<p class="err">${esc(err)}</p>` : ""}
    <form method="post" action="/login"><input type="hidden" name="req" value="${esc(reqId)}">
    <input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password" required>
    <button type="submit">Allow ${esc(info.client_name)}</button></form>`);
  const expired = () => PAGE(`<p class="err">This sign-in link is missing or has expired. Start again from Claude.</p>`);
  const wrongBrowser = () => PAGE(`<p class="err">This sign-in must be finished in the browser where it was started. If you were sent this link, do not enter your passphrase. Start again from Claude.</p>`);
  const bound = (req: Request, id: string) => provider.bindMatches(id, cookieValue(req.headers.cookie, BIND_COOKIE));
  r.get("/login", (req: Request, res: Response) => {
    headers(res);
    const id = typeof req.query.req === "string" && REQ_ID.test(req.query.req) ? req.query.req : "";
    const info = id ? provider.pendingInfo(id) : null;
    if (!info) return res.status(400).send(expired());
    if (!bound(req, id)) {
      log(`oauth: /login for a pending request without its browser cookie (forwarded link?) from ${clientIp(req)}`);
      return res.status(400).send(wrongBrowser());
    }
    res.status(200).send(form(id, info));
  });
  r.post("/login", (req: Request, res: Response) => {
    headers(res);
    const body = (req.body ?? {}) as { req?: unknown; passphrase?: unknown };
    const id = typeof body.req === "string" && REQ_ID.test(body.req) ? body.req : "";
    const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
    if (!id) return res.status(400).send(expired());
    if (!bound(req, id)) return res.status(400).send(wrongBrowser()); // checked before the passphrase is even compared
    const out = provider.completeLogin(id, clientIp(req), passphrase);
    if ("redirect" in out) {
      res.clearCookie(BIND_COOKIE, { path: "/login" });
      return res.redirect(302, out.redirect);
    }
    const info = out.status === 401 ? provider.pendingInfo(id) : null;
    setTimeout(() => res.status(out.status).send(info ? form(id, info, out.error) : PAGE(`<p class="err">${esc(out.error)}</p>`)), FAIL_DELAY_MS);
  });
  return r;
}
