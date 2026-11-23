# plaid-finance-mcp

A small, read-only [MCP](https://modelcontextprotocol.io) server that gives Claude your bank, card and
loan data through [Plaid](https://plaid.com). It keeps balances, transactions and liabilities in a
SQLite file you own and exports a clean CSV for budget reconciliation.

Run it two ways:

- **Local** on your Mac over stdio, for Claude Code. Tokens live in the macOS Keychain.
- **Hosted** on a tiny Fly.io machine with OAuth, so Claude on your phone, claude.ai and scheduled
  routines can use it, and Plaid webhooks keep the data fresh while your laptop is closed.

Read-only by construction: Link, `/accounts/get`, `/accounts/balance/get`, `/transactions/sync`,
`/liabilities/get`, `/institutions/get_by_id`. No auth, payments or transfer products are requested.

### Who this is for

You need to be comfortable in a terminal: installing Node, running npm, editing a `.env` file. You also
need a [Plaid developer account](https://dashboard.plaid.com). Sandbox works immediately with fake banks;
connecting real banks requires Plaid's production approval, which is an application and usually a few
days. If that is not you, Claude's built-in Personal Finance (below) gives you the conversation part with
no setup at all. If it is, `npm run setup` walks you through the rest in about ten minutes.

### Why not Anthropic's Personal Finance?

Claude's built-in [Personal Finance](https://support.claude.com/en/articles/18185620-use-personal-finance-in-claude)
(US beta, Pro and above) also links banks through Plaid and is excellent for questions in chat. This project
was built the same month without knowing it existed, and the two turn out to be complementary. As of
November 2026, Personal Finance cannot export your data and cannot be used from Claude Code, scheduled
tasks or Cowork. This project covers those: a CSV you can drop into a spreadsheet, tools callable from
automations, and a database on disk that is yours. Use Personal Finance for conversation and this for
the plumbing, or either one alone.

## Prerequisites

- **Node 22 or newer** and a C++ toolchain (Xcode Command Line Tools on macOS, `build-essential` on
  Debian/Ubuntu). `better-sqlite3` compiles a native module on install.
- **A Plaid developer account** at <https://dashboard.plaid.com>. Sandbox is free and works immediately
  with fake banks. Real banks need **Production** access, which Plaid grants per developer after a short
  application; personal use is allowed. Budget a few days for approval, and expect a separate registration
  step for some OAuth banks. Plaid bills per linked bank per month once you are in production; a
  household is a few dollars.
- **Claude Code** for local mode. For hosted mode, a claude.ai plan that allows custom connectors, and a
  free [Fly.io](https://fly.io) account. The default machine size fits inside Fly's free monthly allowance.
- Local mode assumes **macOS** for the Keychain. On Linux set `TOKEN_STORE=db` and `TOKEN_ENCRYPTION_KEY`
  in `.env` (see below) and tokens are stored encrypted in SQLite instead.

## Quick start (sandbox, ten minutes)

```bash
git clone https://github.com/piotr-k/plaid-finance-mcp.git && cd plaid-finance-mcp
npm install
npm run setup
```

The setup wizard checks your Node and build toolchain, asks for your Plaid keys from
<https://dashboard.plaid.com/developers/keys> with hidden input and writes them to `.env` (git-ignored),
builds, then runs the sandbox smoke test: it links two fake banks without a browser, syncs them, starts the
real MCP server over stdio, calls every tool and prints `SMOKE OK`. It ends by printing the exact
`claude mcp add` command for your machine. Rerun it any time; existing values are kept unless you choose
to replace them. Never paste keys into a chat.

Prefer to do it by hand? `cp .env.example .env`, fill in `PLAID_CLIENT_ID` and `PLAID_SECRET_SANDBOX`,
then `npm run build && npm run smoke`. (With the Plaid CLI, `plaid keys write --env sandbox --gitignore`
fills the file for you.)

To try the browser flow: `npm run link` opens Plaid's hosted page. Pick any bank and sign in with
`user_good` / `pass_good`. The terminal reports the linked accounts when you finish.

## Connect to Claude Code (local mode)

```bash
claude mcp add --scope user --transport stdio plaid-finance -- \
  "$(command -v node)" "$PWD/dist/server.js"
```

Use absolute paths: MCP servers start without your shell profile, so version managers like nvm are not
loaded. The server finds `.env` next to itself. After `npm run build` changes, restart Claude Code or
reconnect from `/mcp`.

Then in Claude Code: "list my accounts", "sync", "export a CSV for last month".

## Link real banks (production)

1. Confirm your Plaid team has production access for **Transactions** and **Liabilities** in your country
   (Dashboard → Settings → Team → Products).
2. In `.env` set `PLAID_SECRET_PRODUCTION` and `PLAID_ENV=production`. Production data goes to
   `data/plaid-production.db` and a separate Keychain namespace, so sandbox items are untouched.
3. `npm run link`. Connect one bank, return to the terminal, answer `y` to link another. The first sync
   runs immediately; full history can take a minute or two longer, so run the `sync` tool again later.
4. Optional: `cp accounts.example.json accounts.json` and map each account's last four digits to a
   friendly name. An entry can be an object with `promo_end` (YYYY-MM-DD) for a promotional APR end date,
   which Plaid does not expose.

Notes on coverage: Plaid's transaction sync covers depository, credit, mortgage and student-loan accounts.
Other account types (a line of credit, for example) still link and report balances and terms through
`get_liabilities`, but their activity may not appear in `get_transactions`. Some card issuers are not on
Plaid at all; check Plaid's institution search before assuming.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_accounts` | – | institution, account name, mask, type, cached balances, last synced |
| `sync` | – | per-bank counts of added / modified / removed; banks needing re-auth are flagged |
| `get_transactions` | `start_date`, `end_date`, `account_mask?` | date, mask, description, merchant, amount (negative = money out), pending, category |
| `get_balances` | – | live balances via `/accounts/balance/get` (slow and rate-limited by Plaid; use sparingly) |
| `get_liabilities` | `refresh?` (default true) | statement balance/date, minimum due, due date, APRs, promo APR, `promo_end` |
| `export_csv` | `start_date`, `end_date`, `include_content?` | path of `exports/transactions_<today>.csv` plus the CSV text |
| `start_link` (hosted) | `update_item_id?` | Hosted Link URL to connect a new bank or repair one |
| `link_status` (hosted) | – | finalizes finished Link sessions and reports outcomes |
| `unlink` (hosted) | `item_id`, `confirm: true` | removes the bank at Plaid and deletes the token and local rows |

### CSV format

Columns: `date,account,description,amount,pending`

- `date` is `YYYY-MM-DD`; rows are sorted ascending.
- `account` is the last-four mask.
- `description` is Plaid's merchant name when known, otherwise the bank's description.
- `amount` is **negative for money out, positive for money in**. Plaid's raw convention is the opposite,
  so the exporter flips the sign (see `src/export.ts`).
- `pending` is `TRUE` or `FALSE`. Pending rows are replaced when the posted version arrives.

## Hosted mode (Fly.io)

The same code runs as an always-on HTTPS service. What changes:

- `dist/http-server.js` serves MCP over Streamable HTTP at `/mcp`, protected by OAuth 2.1. It is a
  single-user server: clients register dynamically and the login page asks for your `MCP_PASSPHRASE`.
- Access tokens are AES-256-GCM encrypted in SQLite with `TOKEN_ENCRYPTION_KEY`.
- `/plaid/webhook` verifies Plaid's signature and syncs as banks post updates. A daily sync at 09:00 UTC
  catches anything missed.
- Two extra tools, `start_link` and `link_status`. A third, `unlink`, is off by default because it is
  destructive and callable by the model; set `HOSTED_UNLINK=true` to expose it, or unlink from the
  machine with `fly ssh console -C "node dist/cli.js unlink <item_id>"`.
- Linking the same bank twice is fine when it is a different login, for example a second person's own
  account. A new connection is removed as a duplicate only when one of its account masks is already
  linked at that bank. The server log says which check fired (`duplicate check: ...`).

### Deploy fresh

```bash
brew install flyctl && fly auth login            # or https://fly.io/docs/flyctl/install/
npm run setup:hosted
```

The hosted wizard asks for an app name, region and display name, writes `fly.toml`, creates the app and
its volume, generates the token encryption key, asks for your passphrase with hidden input, sets every
secret without going through a shell, deploys, waits for the health check and prints the URLs to paste
into claude.ai and Claude Code. Rerun it to redeploy; it reuses what exists.

By hand, the same steps are:

```bash
cp fly.example.toml fly.toml                     # replace <app> in both places
fly apps create <app>
fly volumes create plaid_data --region <region> --size 1 -a <app>
echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env   # keep a copy locally for export-items
fly secrets set -a <app> \
  PLAID_CLIENT_ID="$(grep ^PLAID_CLIENT_ID= .env | cut -d= -f2-)" \
  PLAID_SECRET_PRODUCTION="$(grep ^PLAID_SECRET_PRODUCTION= .env | cut -d= -f2-)" \
  TOKEN_ENCRYPTION_KEY="$(grep ^TOKEN_ENCRYPTION_KEY= .env | cut -d= -f2-)" \
  MCP_PASSPHRASE='a long passphrase you choose'
fly deploy --ha=false
curl https://<app>.fly.dev/health
```

Reading values out of `.env` with `grep` keeps them off your screen. Check your quoting: an unmatched
quote sets a secret to an empty string without any error.

### Connect Claude

- **claude.ai** (web, desktop, phone): Settings → Connectors → Add custom connector → URL
  `https://<app>.fly.dev/mcp`. Sign in with your passphrase. Scheduled routines can use the same connector.
- **Claude Code:** `claude mcp add --scope user --transport http plaid-cloud https://<app>.fly.dev/mcp`,
  then `/mcp` → authenticate.

Link banks from any device by asking for `start_link`, finishing in the browser, then `link_status`.

### Move banks you already linked locally

```bash
npm run cli -- export-items /tmp/items.json   # tokens encrypted with TOKEN_ENCRYPTION_KEY from .env
fly sftp shell -a <app>                        # then: put /tmp/items.json /data/import.json
fly machine restart -a <app>                   # imports on boot, points webhooks at itself, re-syncs
rm /tmp/items.json
```

### Operate

- `fly logs -a <app>` shows request ids and sync counts, never tokens.
- After a suspected compromise: rotate `MCP_PASSPHRASE`, delete rows from `oauth_tokens` and
  `oauth_clients` (`fly ssh console`, then `sqlite3 /data/plaid-production.db`), and call Plaid's
  `/item/access_token/invalidate` for each bank.
- Fly volumes are not encrypted by default; the token column is. Transactions can always be re-pulled
  from Plaid.

## Maintenance

```bash
npm run cli -- items                     # linked banks, status, last sync
npm run link -- --update <item_id>       # re-authenticate after ITEM_LOGIN_REQUIRED (bank consent expires about yearly)
npm run cli -- unlink <item_id>          # remove at Plaid, delete the token, delete local rows
npm run cli -- reset-login <item_id>     # sandbox only: simulate a broken login
npm test                                 # unit tests
PLAID_ENV=sandbox npm run smoke          # live sandbox test through the MCP server
```

Plaid refreshes transactions on its own schedule, roughly one to four times a day per bank. In local mode
there is no webhook receiver, so `sync` pulls whatever is new when you run it. `sync` never forces a bank
refresh, which Plaid bills separately.

## Security model

- `.env`, databases, `exports/`, `accounts.json` and `fly.toml` are git-ignored.
- Local mode opens no ports. `npm run link` makes outbound calls to Plaid and opens a Plaid-hosted page;
  Plaid handles the banks' OAuth redirects on its own HTTPS domain, so no redirect URI is registered.
- Tokens: Keychain service `plaid-mcp/<env>` (one entry per bank) or an AES-256-GCM column in SQLite.
- Tool output and logs never include `access_token`, `link_token`, `public_token` or API keys; the smoke
  test asserts this.
- Hosted mode: OAuth 2.1 with PKCE, hashed authorization codes and tokens, 30-day access and 90-day refresh
  tokens. Clients may only register redirect URIs matching `ALLOWED_REDIRECTS`: by default the exact claude.ai
  and claude.com callback URLs, plus loopback for Claude Code. The sign-in page names the client and the exact
  address that will receive the code,
  so you can refuse a request you did not start, and it cannot be framed. Each sign-in is also bound
  to the browser that started it with an HttpOnly cookie set at /authorize, so a forwarded sign-in link
  cannot be completed by anyone else. Wrong passphrases are limited to
  3 per sign-in request, 5 per IP and 60 overall per 15 minutes, counted in SQLite so a restart does not
  reset them. The passphrase must be at least 8 characters; use 16 or more. Plaid webhooks are verified
  (ES256, five-minute window) and key lookups for unknown key ids are negative-cached and rate-limited.
- `TRUST_PROXY` defaults to 1 on Fly and 0 elsewhere; set it to your proxy hop count if you run behind
  another reverse proxy, otherwise throttling cannot see real client addresses.
- Bearer tokens need the `finance:read` scope; the link tools additionally need `finance:link`. Live balance
  calls are limited to one per bank per minute because Plaid bills them.
- If a token is ever exposed, call `/item/access_token/invalidate` and rotate the secret in the Plaid
  Dashboard.

## Customizing

- The name shown on Plaid's Link screen and the login page: `APP_NAME` (default "Finance MCP").
- OAuth and hardening knobs: `ALLOWED_REDIRECTS`, `TRUST_PROXY`, `HOSTED_UNLINK` (see `.env.example`).
- Friendly account names and promo dates: `accounts.json`.
- History requested at link time: `TRANSACTION_DAYS` in `.env` (default 365, max 730, fixed per bank once
  linked).
- Daily sync hour: the `schedule()` function in `src/http-server.ts`. OAuth token lifetimes: the TTL
  constants at the top of `src/oauth.ts`.
- CSV columns are intentionally fixed; change `src/export.ts` if your spreadsheet wants something else.

## License

MIT. Contributions are welcome; please keep the read-only product list and the no-tokens-in-logs rule.
