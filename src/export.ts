import fs from "node:fs";
import path from "node:path";
import { EXPORT_DIR } from "./config.js";
import type { DB } from "./db.js";

export const CSV_HEADER = "date,account,description,amount,pending";

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface CsvRow {
  date: string;
  mask: string | null;
  merchant_name: string | null;
  name: string;
  amount: number; // Plaid sign convention
  pending: number;
}

/**
 * Build the CSV body. Columns: date, account, description, amount, pending.
 *
 * Sign: Plaid reports money LEAVING an account as a positive amount and money
 * coming IN as negative. The P&L convention is the opposite, so the amount is
 * negated here: negative = money out, positive = money in. This applies to
 * card accounts too (a purchase is negative, a payment to the card positive).
 */
export function toCsv(rows: CsvRow[]): string {
  const lines = [CSV_HEADER];
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.mask ?? "").localeCompare(b.mask ?? ""));
  for (const r of sorted) {
    const amount = -r.amount;
    lines.push(
      [
        r.date,
        csvCell(r.mask ?? ""),
        csvCell(r.merchant_name || r.name),
        (Object.is(amount, -0) ? 0 : amount).toFixed(2),
        r.pending ? "TRUE" : "FALSE",
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function exportCsv(db: DB, start: string, end: string, today = new Date()): { path: string; rows: number } {
  const rows = db.transactions({ start, end });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const stamp = today.toISOString().slice(0, 10);
  const file = path.join(EXPORT_DIR, `transactions_${stamp}.csv`);
  fs.writeFileSync(file, toCsv(rows), "utf8");
  return { path: file, rows: rows.length };
}
