import fs from "node:fs";
import path from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { APP_NAME, PLAID_ENV, PORT, PUBLIC_URL, WEBHOOK_URL, DATA_DIR, TOKEN_STORE, TRUST_PROXY, HOSTED_UNLINK, mcpPassphrase, tokenEncryptionKey, log } from "./config.js";
import { openDb } from "./db.js";
import { buildServer } from "./tools.js";
import { SqliteOAuthProvider, loginRouter, clientIp, SCOPES } from "./oauth.js";
import { verifyPlaidWebhook, dispatchWebhook, enqueue, type PlaidWebhookBody } from "./webhooks.js";
import { finalizePendingLinkSessions } from "./hosted-link.js";
import { syncAll } from "./sync.js";
import { importEncrypted, readAccessToken } from "./tokens.js";
import { plaid, describeError } from "./plaid.js";

// Hosted entry point (Fly.io). Routes:
//   /.well-known/*, /authorize, /token, /register, /revoke   OAuth 2.1 (SDK router)
//   /login                                                   passphrase page
//   /mcp                                                     MCP Streamable HTTP, bearer-protected
//   /plaid/webhook                                           verified Plaid webhooks
//   /health

if (!PUBLIC_URL) throw new Error("PUBLIC_URL must be set in hosted mode (e.g. https://my-app.fly.dev)");
if (TOKEN_STORE !== "db") throw new Error("hosted mode requires TOKEN_STORE=db and TOKEN_ENCRYPTION_KEY");
tokenEncryptionKey(); // fail fast on a bad key
mcpPassphrase(); // and on a missing passphrase

const db = openDb();
const provider = new SqliteOAuthProvider(db);
const issuer = new URL(PUBLIC_URL);
const mcpUrl = new URL("/mcp", PUBLIC_URL);

const app = express();
app.set("trust proxy", TRUST_PROXY); // hops in front of us: 1 on Fly; set TRUST_PROXY=0 on a bare VM
app.disable("x-powered-by");

// Webhook first, with the raw body: the signature covers the exact bytes.
app.post("/plaid/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    await verifyPlaidWebhook(req.body, req.header("plaid-verification")); // rejects empty/non-Buffer bodies
  } catch (e) {
    log(`webhook rejected: ${describeError(e)}`);
    return res.status(401).end();
  }
  res.status(200).end(); // acknowledge within the 10s window; work continues async
  try {
    dispatchWebhook(db, JSON.parse((req.body as Buffer).toString("utf8")) as PlaidWebhookBody);
  } catch (e) {
    log(`webhook parse error: ${e instanceof Error ? e.message : e}`);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, environment: PLAID_ENV, items: db.items().length }));

// Visibility into the OAuth endpoints the SDK handles for us: one line per response, with the
// error code and description on failure. Never bodies, never tokens or secrets.
app.use(["/token", "/register", "/authorize", "/revoke"], (req, res, next) => {
  const started = Date.now();
  const origJson = res.json.bind(res);
  let errorText = "";
  res.json = ((body: unknown) => {
    const b = body as { error?: string; error_description?: string } | null;
    if (res.statusCode >= 400 && b && typeof b === "object" && b.error) errorText = ` ${b.error}: ${String(b.error_description ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
    return origJson(body);
  }) as typeof res.json;
  res.on("finish", () => {
    const where = req.baseUrl || req.path;
    const grant = where === "/token" && req.body && typeof req.body === "object" ? ` grant=${String((req.body as { grant_type?: unknown }).grant_type ?? "?")}` : "";
    if (res.statusCode >= 400 || where === "/token") log(`oauth: ${req.method} ${where} -> ${res.statusCode}${grant}${errorText} (${Date.now() - started}ms, from ${clientIp(req)})`);
  });
  next();
});

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: issuer,
    resourceServerUrl: mcpUrl,
    resourceName: APP_NAME,
    scopesSupported: SCOPES,
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }),
);
app.use(loginRouter(provider));

// Bearer auth runs before the JSON body is parsed, so anonymous requests cost nothing but a header read.
const auth = requireBearerAuth({ verifier: provider, requiredScopes: ["finance:read"], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

// Stateless Streamable HTTP: one short-lived server+transport per request. No
// session bookkeeping to lose on a restart, and no SSE streams to hold open.
app.all("/mcp", auth, express.json({ limit: "4mb" }), async (req, res) => {
  const server = buildServer(db, { hosted: true, scopes: req.auth?.scopes ?? [] });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log(`mcp: ${describeError(e)}`);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
  }
});

app.get("/", (_req, res) => res.type("text/plain").send(`${APP_NAME}. Connect through Claude; MCP endpoint at /mcp.`));

/** One-time import of items exported from the laptop (cli export-items). Same TOKEN_ENCRYPTION_KEY on both sides. */
function importIfPresent() {
  const file = path.join(DATA_DIR, "import.json");
  if (!fs.existsSync(file)) return;
  const bundle = JSON.parse(fs.readFileSync(file, "utf8")) as {
    environment: string;
    items: { item_id: string; institution_id: string | null; institution_name: string | null; token: { ciphertext: string; iv: string; tag: string }; accounts: Parameters<typeof db.upsertAccounts>[0] }[];
  };
  if (bundle.environment !== PLAID_ENV) {
    log(`import.json is for ${bundle.environment}, server runs ${PLAID_ENV}; skipping`);
    return;
  }
  for (const it of bundle.items) {
    db.upsertItem({ item_id: it.item_id, institution_id: it.institution_id, institution_name: it.institution_name });
    // The cursor is deliberately NOT imported: the post-import sync starts from
    // scratch so Plaid re-delivers the item's full history to this server.
    importEncrypted(it.item_id, it.token);
    db.upsertAccounts(it.accounts);
    log(`imported item ${it.item_id} (${it.institution_name})`);
  }
  fs.renameSync(file, `${file}.imported-${Date.now()}`);
}

/**
 * On every boot: make sure each item's webhook points here (imported items
 * never had a receiver) and give never-synced items their first sync. Both
 * are idempotent, so a boot without Plaid credentials just retries next time.
 */
function reconcileItemsOnBoot() {
  enqueue("boot reconcile", async () => {
    for (const item of db.items()) {
      try {
        const token = readAccessToken(item.item_id);
        const cur = await plaid().item.get({ access_token: token });
        if (WEBHOOK_URL && cur.item.webhook !== WEBHOOK_URL) {
          await plaid().item.updateWebhook({ access_token: token, webhook: WEBHOOK_URL });
          log(`item ${item.item_id}: webhook set to ${WEBHOOK_URL}`);
        }
      } catch (e) {
        log(`item ${item.item_id}: webhook check failed: ${describeError(e)}`);
      }
    }
    const fresh = db.items().filter((i) => !i.last_synced_at);
    if (fresh.length) log(`first sync for ${fresh.length} item(s)`);
    if (fresh.length) await syncAll(db);
  });
}

function schedule() {
  // Finalize Hosted Link sessions whose LINK webhook was missed.
  setInterval(() => enqueue("link finalize", () => finalizePendingLinkSessions(db)), 60_000).unref();
  // Daily reconcile sync (webhooks are the primary trigger; this catches misses) at 09:00 UTC.
  setInterval(() => {
    const d = new Date();
    if (d.getUTCHours() === 9 && d.getUTCMinutes() === 0) enqueue("daily sync", () => syncAll(db));
  }, 60_000).unref();
  setInterval(() => provider.cleanup(), 3_600_000).unref();
}

importIfPresent();
reconcileItemsOnBoot();
schedule();
app.listen(PORT, "0.0.0.0", () => log(`hosted plaid-finance ready on :${PORT} (${PLAID_ENV}), public ${PUBLIC_URL}, webhook ${WEBHOOK_URL}, unlink tool ${HOSTED_UNLINK ? "enabled" : "disabled (HOSTED_UNLINK=true to enable)"}`));
