# Reference

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_accounts` | – | institution, account name, mask, type, cached balances, last synced |
| `sync` | – | per-bank counts of added / modified / removed; banks needing re-auth are flagged |
| `get_transactions` | `start_date`, `end_date`, `account_mask?` | date, mask, description, merchant, amount (negative = money out), pending, category |
| `get_balances` | – | live balances via `/accounts/balance/get` (slow and rate-limited by Plaid; use sparingly; at most one live call per bank per minute) |
| `get_liabilities` | `refresh?` (default true) | statement balance/date, minimum due, due date, APRs, promo APR, `promo_end` |
| `export_csv` | `start_date`, `end_date`, `include_content?` | path of `exports/transactions_<today>.csv` plus the CSV text |
| `start_link` (hosted) | `update_item_id?` | Hosted Link URL to connect a new bank or repair one |
| `link_status` (hosted) | – | finalizes finished Link sessions and reports outcomes |
| `unlink` (hosted, off unless `HOSTED_UNLINK=true`) | `item_id`, `confirm: true` | removes the bank at Plaid and deletes the token and local rows |

## CSV format

Columns: `date,account,description,amount,pending`

- `date` is `YYYY-MM-DD`; rows are sorted ascending.
- `account` is the last-four mask.
- `description` is Plaid's merchant name when known, otherwise the bank's description.
- `amount` is **negative for money out, positive for money in**. Plaid's raw convention is the opposite,
  so the exporter flips the sign (see `src/export.ts`).
- `pending` is `TRUE` or `FALSE`. Pending rows are replaced when the posted version arrives.

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

## Customizing

- The name shown on Plaid's Link screen and the login page: `APP_NAME` (default "Finance MCP").
- OAuth and hardening knobs: `ALLOWED_REDIRECTS`, `TRUST_PROXY`, `HOSTED_UNLINK` (see `.env.example`).
- Friendly account names and promo dates: `accounts.json`.
- History requested at link time: `TRANSACTION_DAYS` in `.env` (default 365, max 730, fixed per bank once
  linked).
- Daily sync hour: the `schedule()` function in `src/http-server.ts`. OAuth token lifetimes: the TTL
  constants at the top of `src/oauth.ts`.
- CSV columns are intentionally fixed; change `src/export.ts` if your spreadsheet wants something else.
