import { PLAID_ENV, log } from "./config.js";
import { openDb } from "./db.js";
import fs from "node:fs";
import { readAccessToken, exportEncrypted } from "./tokens.js";
import { plaid, describeError } from "./plaid.js";
import { syncAll } from "./sync.js";
import { exportCsv } from "./export.js";
import { unlinkItem } from "./hosted-link.js";

// Small maintenance CLI: npm run cli -- <command>
//   items                 list linked items and their status
//   sync                  run a sync from the terminal
//   export <start> <end>  write a CSV
//   unlink <item_id>      /item/remove + delete token + delete local rows
//   reset-login <item_id> (sandbox only) force ITEM_LOGIN_REQUIRED to test re-link
//   export-items <file>   write items/accounts + tokens encrypted with TOKEN_ENCRYPTION_KEY
//                         for import by a hosted server that shares the key

const [cmd, ...args] = process.argv.slice(2);
const db = openDb();

async function main() {
  switch (cmd) {
    case "items": {
      for (const i of db.items()) {
        const n = db.accountsForItem(i.item_id).length;
        console.log(`${i.item_id}  ${i.institution_name ?? "?"} (${i.institution_id ?? "?"})  accounts=${n}  status=${i.status}${i.error_code ? "/" + i.error_code : ""}  last_sync=${i.last_synced_at ?? "never"}`);
      }
      if (db.items().length === 0) console.log(`No items linked in ${PLAID_ENV}. Run: npm run link`);
      break;
    }
    case "sync": {
      const r = await syncAll(db);
      console.table(r.map(({ institution, added, modified, removed, replaced_pending, update_status, error }) => ({ institution, added, modified, removed, replaced_pending, update_status, error })));
      break;
    }
    case "export": {
      const [start, end] = args;
      if (!start || !end) throw new Error("usage: export YYYY-MM-DD YYYY-MM-DD");
      console.log(exportCsv(db, start, end));
      break;
    }
    case "unlink": {
      const [itemId] = args;
      if (!itemId) throw new Error("usage: unlink <item_id>");
      console.log(await unlinkItem(db, itemId));
      break;
    }
    case "export-items": {
      const [file] = args;
      if (!file) throw new Error("usage: export-items <file.json>  (needs TOKEN_ENCRYPTION_KEY in .env)");
      const bundle = {
        environment: PLAID_ENV,
        exported_at: new Date().toISOString(),
        // No cursor: the importing server re-syncs the full history from Plaid.
        items: db.items().map(({ cursor: _cursor, ...i }) => ({ ...i, token: exportEncrypted(i.item_id), accounts: db.accountsForItem(i.item_id) })),
      };
      fs.writeFileSync(file, JSON.stringify(bundle, null, 2), { mode: 0o600 });
      log(`wrote ${bundle.items.length} item(s) to ${file}; tokens are encrypted, but treat the file as sensitive and delete it after import`);
      break;
    }
    case "reset-login": {
      if (PLAID_ENV !== "sandbox") throw new Error("reset-login is sandbox only");
      const [itemId] = args;
      if (!itemId) throw new Error("usage: reset-login <item_id>");
      await plaid().sandbox.resetItemLogin({ access_token: readAccessToken(itemId) });
      console.log(`item ${itemId} now requires re-login; run: npm run link -- --update ${itemId}`);
      break;
    }
    default:
      console.log("commands: items | sync | export <start> <end> | unlink <item_id> | reset-login <item_id> | export-items <file>");
  }
}

main()
  .catch((e) => {
    console.error(describeError(e));
    process.exit(1);
  })
  .finally(() => db.close());
