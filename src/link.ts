import { execFile } from "node:child_process";
import readline from "node:readline/promises";
import { PLAID_ENV, LINK_TIMEOUT_SECONDS, log } from "./config.js";
import { openDb } from "./db.js";
import { describeError, plaidError } from "./plaid.js";
import { startHostedLink, finalizeLinkSession } from "./hosted-link.js";

// `npm run link` — connect a bank from the terminal with Plaid Hosted Link.
//   npm run link                     link a new institution (repeatable)
//   npm run link -- --update <item>  update mode (re-auth after ITEM_LOGIN_REQUIRED)

const db = openDb();
const updateItemId = (() => {
  const i = process.argv.indexOf("--update");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const ask = async (q: string) => { try { return await rl.question(q); } catch { return ""; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function linkOnce(): Promise<void> {
  const started = await startHostedLink(db, { updateItemId });
  log(`Opening Plaid Link in your browser (${PLAID_ENV}${updateItemId ? `, update mode for ${updateItemId}` : ""}).`);
  log(`If it did not open, paste this into a browser:\n\n  ${started.url}\n`);
  if (process.env.NO_OPEN !== "1") execFile("open", [started.url], () => {});

  const deadline = Date.now() + LINK_TIMEOUT_SECONDS * 1000;
  let ticks = 0;
  while (Date.now() < deadline) {
    await sleep(4000);
    const o = await finalizeLinkSession(db, started.link_token);
    if (o.status !== "pending") {
      log(o.message);
      for (const it of o.items ?? []) {
        for (const a of it.accounts) log(`  ${a.type}/${a.subtype ?? "?"}  ${a.name}  ••${a.mask ?? "????"}`);
        log(`  first sync: +${it.first_sync.added} (${it.first_sync.status ?? "?"})${it.first_sync.error ? ` error ${it.first_sync.error}` : ""}`);
        if (it.first_sync.status !== "HISTORICAL_UPDATE_COMPLETE") log("  history is still importing; run the sync tool again in a minute.");
      }
      return;
    }
    if (++ticks % 15 === 0) log("still waiting for you to finish in the browser…");
  }
  log("Timed out waiting for the Link session; nothing was linked.");
}

async function main() {
  for (;;) {
    try {
      await linkOnce();
    } catch (e) {
      const msg = (e as { body?: { error_message?: string } }).body?.error_message;
      log(`failed: ${describeError(e)}${plaidError(e) && msg ? ` — ${msg}` : ""}`);
    }
    if (updateItemId) break;
    if (!/^y/i.test(await ask("Link another institution? [y/N] "))) break;
  }
  rl.close();
  db.close();
}

main().catch((e) => {
  log("fatal:", describeError(e));
  process.exit(1);
});
