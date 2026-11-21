import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import express from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidClientError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { DB } from "./db.js";
import { APP_NAME, mcpPassphrase, log } from "./config.js";

// A minimal OAuth 2.1 authorization server for exactly one human: you.
// Clients (claude.ai, Claude Code) register dynamically, start the PKCE flow,
// and land on /login, where the only credential is the passphrase in
// MCP_PASSPHRASE. Codes and tokens are random, stored hashed in SQLite.

const ACCESS_TTL_S = 30 * 24 * 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const CODE_TTL_S = 10 * 60;
const PENDING_TTL_S = 15 * 60;
export const SCOPES = ["finance:read", "finance:link"];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

type Pending = AuthorizationParams & { clientId: string };

export class SqliteOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private attempts = new Map<string, { n: number; until: number }>();

  constructor(private db: DB) {
    const raw = db.raw;
    this.clientsStore = {
      getClient(clientId) {
        const row = raw.prepare(`SELECT data FROM oauth_clients WHERE client_id = ?`).get(clientId) as { data: string } | undefined;
        return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
      },
      registerClient(client) {
        const full = { ...(client as OAuthClientInformationFull) };
        full.client_id ||= randomUUID();
        full.client_id_issued_at ||= now();
        raw.prepare(`INSERT INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)`).run(full.client_id, JSON.stringify(full), new Date().toISOString());
        log(`oauth: registered client ${full.client_id} (${full.client_name ?? "unnamed"}) redirect_uris=${full.redirect_uris.join(",")}`);
        return full;
      },
    };
  }

  /** Step 1: park the request and send the user to the login page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = token();
    const pending: Pending = { ...params, clientId: client.client_id, resource: params.resource };
    this.db.raw
      .prepare(`INSERT INTO oauth_pending (id, client_id, params, expires_at) VALUES (?, ?, ?, ?)`)
      .run(id, client.client_id, JSON.stringify({ ...pending, resource: params.resource?.toString() }), now() + PENDING_TTL_S);
    res.redirect(302, `/login?req=${encodeURIComponent(id)}`);
  }

  /** Step 2 (called from the /login POST): passphrase ok → issue a code and redirect back to the client. */
  completeLogin(reqId: string, ip: string, passphrase: string): { redirect: string } | { error: string; status: number } {
    const a = this.attempts.get(ip);
    if (a && a.n >= 5 && a.until > now()) return { error: "Too many attempts. Try again in 15 minutes.", status: 429 };
    const row = this.db.raw.prepare(`SELECT client_id, params, expires_at FROM oauth_pending WHERE id = ?`).get(reqId) as
      | { client_id: string; params: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now()) return { error: "This sign-in link has expired. Start again from Claude.", status: 400 };
    const expected = Buffer.from(mcpPassphrase());
    const given = Buffer.from(passphrase);
    const ok = expected.length === given.length && timingSafeEqual(expected, given);
    if (!ok) {
      const cur = this.attempts.get(ip) ?? { n: 0, until: 0 };
      this.attempts.set(ip, { n: cur.n + 1, until: now() + 15 * 60 });
      log(`oauth: wrong passphrase from ${ip}`);
      return { error: "Wrong passphrase.", status: 401 };
    }
    this.attempts.delete(ip);
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

  /** Drop expired codes, pending requests and tokens. */
  cleanup(): void {
    const t = now();
    this.db.raw.prepare(`DELETE FROM oauth_pending WHERE expires_at < ?`).run(t);
    this.db.raw.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).run(t);
    this.db.raw.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`).run(t);
  }
}

const PAGE = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · ${APP_NAME}</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 20px;color:#111}
input{font:inherit;width:100%;padding:10px 12px;border:1px solid #bbb;border-radius:8px;box-sizing:border-box}
button{font:inherit;margin-top:12px;padding:10px 18px;border-radius:8px;border:0;background:#111;color:#fff;width:100%}
.err{color:#b00020;margin:8px 0}</style></head><body>${body}</body></html>`;

/** Express routes for the login page used by SqliteOAuthProvider.authorize. */
export function loginRouter(provider: SqliteOAuthProvider): Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  const form = (req: string, err = "") =>
    PAGE(`<h2>${APP_NAME}</h2><p>Claude is asking to connect to your bank data. Enter the passphrase to allow it.</p>
    ${err ? `<p class="err">${err}</p>` : ""}
    <form method="post" action="/login"><input type="hidden" name="req" value="${req}">
    <input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password" required>
    <button type="submit">Allow</button></form>`);
  r.get("/login", (req: Request, res: Response) => {
    const id = typeof req.query.req === "string" ? req.query.req : "";
    res.setHeader("Cache-Control", "no-store");
    res.status(id ? 200 : 400).send(id ? form(encodeURIComponent(id)) : PAGE("<p>Missing request.</p>"));
  });
  r.post("/login", (req: Request, res: Response) => {
    const body = req.body as { req?: string; passphrase?: string };
    const ip = (req.headers["fly-client-ip"] as string | undefined) ?? req.ip ?? "unknown";
    const out = provider.completeLogin(decodeURIComponent(body.req ?? ""), ip, body.passphrase ?? "");
    res.setHeader("Cache-Control", "no-store");
    if ("redirect" in out) return res.redirect(302, out.redirect);
    res.status(out.status).send(out.status === 401 && body.req ? form(body.req, out.error) : PAGE(`<p class="err">${out.error}</p>`));
  });
  return r;
}
