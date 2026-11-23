# Local mode

The database is a file on your computer and the server runs only while Claude Code uses it, on that
computer. Nothing listens on the network. Tokens live in the macOS Keychain, or encrypted in the database
on Linux (`TOKEN_STORE=db` plus `TOKEN_ENCRYPTION_KEY` in `.env`).

## Quick start (sandbox)

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

## Connect Claude Code

```bash
claude mcp add --scope user --transport stdio plaid-finance -- \
  "$(command -v node)" "$PWD/dist/server.js"
```

Use absolute paths: MCP servers start without your shell profile, so version managers like nvm are not
loaded. The server finds `.env` next to itself. After `npm run build` changes, restart Claude Code or
reconnect from `/mcp`.

Then in Claude Code: "list my accounts", "sync", "export a CSV for last month".

## Link real banks

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

## Next

- Reach your data away from the computer: [docs/hosted.md](hosted.md).
- Tool arguments, the CSV format, maintenance commands: [docs/reference.md](reference.md).
