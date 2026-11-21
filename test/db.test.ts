import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";

const tx = (id: string, extra: Partial<Parameters<ReturnType<typeof openDb>["applySync"]>[1]["added"][number]> = {}) => ({
  transaction_id: id,
  account_id: "acc1",
  item_id: "item1",
  date: "2026-11-10",
  authorized_date: null,
  name: "COFFEE",
  merchant_name: "Coffee",
  original_description: null,
  amount: 4.5,
  iso_currency_code: "USD",
  pending: 0,
  pending_transaction_id: null,
  category_primary: null,
  category_detailed: null,
  category_confidence: null,
  payment_channel: null,
  ...extra,
});

function fresh() {
  const db = openDb(":memory:");
  db.upsertItem({ item_id: "item1", institution_id: "ins_1", institution_name: "Test Bank" });
  db.upsertAccounts([{ account_id: "acc1", item_id: "item1", name: "Checking", official_name: null, mask: "1234", type: "depository", subtype: "checking", current: 1, available: 1, limit_amount: null, iso_currency_code: "USD", balance_updated_at: null }]);
  return db;
}

test("pending transaction is replaced when it posts (via pending_transaction_id)", () => {
  const db = fresh();
  db.applySync("item1", { added: [tx("p1", { pending: 1, date: "2026-11-09" })], modified: [], removed: [], nextCursor: "c1" });
  assert.equal(db.transactionCount(), 1);
  db.applySync("item1", { added: [tx("t1", { pending_transaction_id: "p1" })], modified: [], removed: [], nextCursor: "c2" });
  const rows = db.transactions({ start: "2026-01-01", end: "2026-12-31" });
  assert.deepEqual(rows.map((r) => r.transaction_id), ["t1"]);
  assert.equal(db.item("item1")?.cursor, "c2");
});

test("removed deletes, modified upserts, cursor persists atomically", () => {
  const db = fresh();
  db.applySync("item1", { added: [tx("a"), tx("b")], modified: [], removed: [], nextCursor: "c1" });
  const r = db.applySync("item1", { added: [], modified: [tx("a", { amount: 9 })], removed: ["b"], nextCursor: "c2" });
  assert.deepEqual(r, { added: 0, modified: 1, removed: 1, replaced_pending: 0 });
  const rows = db.transactions({ start: "2026-01-01", end: "2026-12-31" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 9);
});

test("mask filter and date bounds", () => {
  const db = fresh();
  db.applySync("item1", { added: [tx("a", { date: "2026-11-01" }), tx("b", { date: "2026-11-30" })], modified: [], removed: [], nextCursor: "c" });
  assert.equal(db.transactions({ start: "2026-11-01", end: "2026-11-15" }).length, 1);
  assert.equal(db.transactions({ start: "2026-11-01", end: "2026-11-30", mask: "9999" }).length, 0);
  assert.equal(db.transactions({ start: "2026-11-01", end: "2026-11-30", mask: "1234" }).length, 2);
});
