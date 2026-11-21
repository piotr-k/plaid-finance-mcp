import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, CSV_HEADER } from "../src/export.js";

test("CSV flips Plaid sign, sorts by date, quotes commas, TRUE/FALSE pending", () => {
  const csv = toCsv([
    { date: "2026-11-03", mask: "1234", merchant_name: "Safeway", name: "SAFEWAY #123", amount: 42.5, pending: 0 },
    { date: "2026-11-01", mask: "3456", merchant_name: null, name: "Payroll, ACME", amount: -2500, pending: 0 },
    { date: "2026-11-02", mask: "5678", merchant_name: "Shell", name: "SHELL OIL", amount: 60, pending: 1 },
  ]);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines[1], '2026-11-01,3456,"Payroll, ACME",2500.00,FALSE');
  assert.equal(lines[2], "2026-11-02,5678,Shell,-60.00,TRUE");
  assert.equal(lines[3], "2026-11-03,1234,Safeway,-42.50,FALSE");
});

test("zero amount never renders as -0.00", () => {
  const csv = toCsv([{ date: "2026-01-01", mask: "1", merchant_name: null, name: "x", amount: 0, pending: 0 }]);
  assert.match(csv, /,0\.00,/);
});
