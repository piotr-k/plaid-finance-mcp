/**
 * End-to-end sandbox smoke test (no browser needed):
 *   1. /sandbox/public_token/create for First Platypus Bank with the dynamic-transactions user
 *   2. exchange -> token store (Keychain or encrypted SQLite), record item in SQLite
 *   3. start the real MCP server over stdio and call every tool through an MCP client
 *   4. print a summary; never prints tokens
 * Run: npm run smoke   (PLAID_ENV must be sandbox)
 */
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PLAID_ENV, ROOT, log } from "../src/config.js";
import { openDb } from "../src/db.js";
import { storeAccessToken } from "../src/tokens.js";
import { plaid, describeError, COUNTRY_CODES } from "../src/plaid.js";
import { refreshAccounts, syncItem } from "../src/sync.js";

if (PLAID_ENV !== "sandbox") {
  console.error("smoke test only runs with PLAID_ENV=sandbox");
  process.exit(1);
}

// Two personas with different data shapes (a logic that only works on one sandbox user is suspect):
const PERSONAS = [
  { institution: "ins_109508", username: "user_transactions_dynamic" }, // First Platypus Bank, evolving transactions
  { institution: "ins_109511", username: "user_good" }, // Tartan Bank, static fixture
];
const db = openDb();

async function ensureItem(institution: string, username: string): Promise<string> {
  const existing = db.itemsByInstitution(institution)[0];
  if (existing) return existing.item_id;
  const pt = await plaid().sandbox.createPublicToken({
    institution_id: institution,
    initial_products: ["transactions"],
    options: { override_username: username, override_password: "pass_good", transactions: { days_requested: 90 } },
  });
  const ex = await plaid().item.exchangePublicToken({ public_token: pt.public_token });
  storeAccessToken(ex.item_id, ex.access_token);
  const inst = await plaid().institutions.getById({ institution_id: institution, country_codes: COUNTRY_CODES });
  db.upsertItem({ item_id: ex.item_id, institution_id: institution, institution_name: inst.institution.name });
  await refreshAccounts(db, ex.item_id);
  log(`linked sandbox item ${ex.item_id} at ${inst.institution.name} (request_id ${ex.request_id})`);
  return ex.item_id;
}

async function waitForHistory(itemId: string) {
  // No webhook receiver on a laptop, so poll a few times with backoff until the
  // sandbox backfill completes. Bounded: at most ~90s.
  let delay = 3000;
  for (let i = 0; i < 8; i++) {
    const r = await syncItem(db, itemId);
    log(`sync pass ${i + 1}: +${r.added} ~${r.modified} -${r.removed} status=${r.update_status} ${r.error ?? ""}`);
    if (r.error) throw new Error(r.error);
    if (r.update_status === "HISTORICAL_UPDATE_COMPLETE" && db.transactionCount() > 0) return;
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(delay * 1.6, 20000);
  }
  log("history still not complete; continuing with what we have");
}

async function main() {
  for (const p of PERSONAS) await waitForHistory(await ensureItem(p.institution, p.username));
  db.close();

  const serverPath = path.join(ROOT, "dist", "server.js");
  if (!fs.existsSync(serverPath)) throw new Error("dist/server.js missing; run npm run build first");
  // The child gets a filtered env by default; force sandbox so it matches this script.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: "inherit",
    env: { ...getDefaultEnvironment(), PLAID_ENV: "sandbox" },
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log("tools:", tools.join(", "));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    const parsed = JSON.parse(text);
    if (/access-(sandbox|production)-|"secret"/i.test(text)) throw new Error(`${name}: output leaked a secret`);
    return parsed;
  };

  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);

  const expect = (cond: unknown, msg: string) => { if (!cond) throw new Error(`assertion failed: ${msg}`); };
  const accounts = await call("list_accounts");
  console.log(`list_accounts: ${accounts.accounts.length} accounts`);
  expect(accounts.environment === "sandbox", "server runs in sandbox");
  expect(accounts.accounts.length > 0, "at least one account");
  const institutions = new Set(accounts.accounts.map((a: { institution: string }) => a.institution));
  console.log(`institutions: ${[...institutions].join(", ")}`);
  expect(institutions.size >= 2, "both personas linked");
  const sync = await call("sync");
  console.log(`sync: totals ${JSON.stringify(sync.totals)}, ${sync.transactions_in_db} in db`);
  expect(sync.transactions_in_db > 0, "transactions stored");
  const txs = await call("get_transactions", { start_date: start, end_date: end });
  console.log(`get_transactions: ${txs.count} rows; first: ${JSON.stringify(txs.transactions[0] ?? null)}`);
  expect(txs.count > 0, "get_transactions returns rows");
  for (const inst of institutions) expect(txs.transactions.some((t: { institution: string }) => t.institution === inst), `transactions present for ${inst}`);
  const mask = accounts.accounts.find((a: { mask: string | null }) => a.mask)?.mask;
  if (mask) {
    const one = await call("get_transactions", { start_date: start, end_date: end, account_mask: mask });
    console.log(`get_transactions(mask=${mask}): ${one.count} rows`);
  }
  const bal = await call("get_balances");
  console.log(`get_balances: ${bal.balances.length} rows; first: ${JSON.stringify(bal.balances[0] ?? null)}`);
  expect(bal.balances.length > 0 && !bal.balances[0].error, "live balances returned");
  const liab = await call("get_liabilities");
  console.log(`get_liabilities: ${liab.liabilities.length} rows, items_checked=${liab.items_checked}, errors=${JSON.stringify(liab.errors)}`);
  if (liab.liabilities[0]) console.log("  first:", JSON.stringify(liab.liabilities[0]));
  const csv = await call("export_csv", { start_date: start, end_date: end });
  console.log(`export_csv: ${csv.rows} rows -> ${csv.path}`);
  expect(csv.rows === txs.count, "CSV row count matches get_transactions");
  console.log(fs.readFileSync(csv.path, "utf8").split("\n").slice(0, 4).join("\n"));

  await client.close();
  console.log("\nSMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", describeError(e));
  process.exit(1);
});
