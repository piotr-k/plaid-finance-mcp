import type { Plaid } from "plaid";
import type { DB } from "./db.js";
import { readAccessToken } from "./tokens.js";
import { plaid, withRetry, plaidError, describeError } from "./plaid.js";
import { accountMeta, friendlyName } from "./names.js";

const LIABILITY_TYPES = new Set(["credit", "loan"]);

export interface LiabilitySummary {
  institution: string | null;
  account: string; // mask
  name: string;
  kind: string;
  current_balance: number | null;
  statement_balance: number | null;
  statement_date: string | null;
  minimum_due: number | null;
  due_date: string | null;
  apr_percent: number | null; // purchase APR for cards, interest rate for loans
  aprs: { type: string; percent: number; balance_subject: number | null }[];
  promo_apr_percent: number | null; // Plaid "special" APR when present
  promo_end: string | null; // from accounts.json only; Plaid does not expose promo end dates
  is_overdue: boolean | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  extra: Record<string, unknown>;
  updated_at: string;
}

/** Fetch /liabilities/get for every item that has a credit or loan account, store raw payloads. */
export async function refreshLiabilities(db: DB, onlyItemId?: string): Promise<{ items_checked: number; errors: string[] }> {
  const errors: string[] = [];
  let checked = 0;
  for (const item of db.items()) {
    if (onlyItemId && item.item_id !== onlyItemId) continue;
    const accts = db.accountsForItem(item.item_id);
    if (!accts.some((a) => LIABILITY_TYPES.has(a.type))) continue; // avoids NO_LIABILITY_ACCOUNTS
    checked++;
    try {
      const accessToken = readAccessToken(item.item_id);
      const res = await withRetry(`liabilities/get ${item.item_id}`, () => plaid().liabilities.get({ access_token: accessToken }));
      const rows: { account_id: string; item_id: string; kind: string; payload: string }[] = [];
      const push = (kind: string, list: { account_id: string | null }[] | null | undefined) => {
        for (const l of list ?? []) if (l.account_id) rows.push({ account_id: l.account_id, item_id: item.item_id, kind, payload: JSON.stringify(l) });
      };
      const L: Plaid.LiabilitiesObject = res.liabilities;
      push("credit", L.credit);
      push("mortgage", L.mortgage);
      push("student", L.student);
      push("loan", L.loan);
      push("line_of_credit", L.line_of_credit);
      db.upsertLiabilities(rows);
      // /liabilities/get also returns accounts with cached balances; keep them fresh.
      const { accountToRow } = await import("./sync.js");
      db.upsertAccounts(res.accounts.map((a) => accountToRow(item.item_id, a)));
    } catch (err) {
      const pe = plaidError(err);
      if (pe?.error_code === "NO_LIABILITY_ACCOUNTS" || pe?.error_code === "PRODUCTS_NOT_SUPPORTED") continue;
      errors.push(`${item.institution_name ?? item.item_id}: ${describeError(err)}`);
    }
  }
  return { items_checked: checked, errors };
}

function aprList(aprs: Plaid.Apr[] | undefined): LiabilitySummary["aprs"] {
  return (aprs ?? []).map((a) => ({ type: String(a.apr_type), percent: a.apr_percentage, balance_subject: a.balance_subject_to_apr ?? null }));
}

export function summarizeLiabilities(db: DB): LiabilitySummary[] {
  const accounts = new Map(db.accounts().map((a) => [a.account_id, a]));
  const items = new Map(db.items().map((i) => [i.item_id, i]));
  const out: LiabilitySummary[] = [];
  for (const row of db.liabilities()) {
    const acct = accounts.get(row.account_id);
    const mask = acct?.mask ?? "";
    const meta = accountMeta(mask);
    const base: LiabilitySummary = {
      institution: items.get(row.item_id)?.institution_name ?? null,
      account: mask,
      name: friendlyName(mask, acct?.name ?? row.account_id),
      kind: row.kind,
      current_balance: acct?.current ?? null,
      statement_balance: null,
      statement_date: null,
      minimum_due: null,
      due_date: null,
      apr_percent: null,
      aprs: [],
      promo_apr_percent: null,
      promo_end: meta.promo_end ?? null,
      is_overdue: null,
      last_payment_amount: null,
      last_payment_date: null,
      extra: {},
      updated_at: row.updated_at,
    };
    const p = JSON.parse(row.payload);
    switch (row.kind) {
      case "credit": {
        const c = p as Plaid.CreditCardLiability;
        const aprs = aprList(c.aprs);
        Object.assign(base, {
          statement_balance: c.last_statement_balance ?? null,
          statement_date: c.last_statement_issue_date ?? null,
          minimum_due: c.minimum_payment_amount ?? null,
          due_date: c.next_payment_due_date ?? null,
          apr_percent: aprs.find((a) => a.type === "purchase_apr")?.percent ?? aprs[0]?.percent ?? null,
          aprs,
          promo_apr_percent: aprs.find((a) => a.type === "special")?.percent ?? null,
          is_overdue: c.is_overdue ?? null,
          last_payment_amount: c.last_payment_amount ?? null,
          last_payment_date: c.last_payment_date ?? null,
        });
        break;
      }
      case "line_of_credit": {
        const c = p as Plaid.LineOfCreditLiability;
        const aprs = aprList(c.aprs);
        Object.assign(base, {
          statement_balance: c.last_statement_balance ?? null,
          statement_date: c.last_statement_issue_date ?? null,
          minimum_due: c.minimum_payment_amount ?? null,
          due_date: c.next_payment_due_date ?? null,
          apr_percent: c.interest_rate?.percentage ?? aprs[0]?.percent ?? null,
          aprs,
          last_payment_amount: c.last_payment_amount ?? null,
          last_payment_date: c.last_payment_date ?? null,
          extra: { credit_limit: c.credit_limit, available_credit: c.available_credit, principal_balance: c.principal_balance, draw_period_end_date: c.draw_period_end_date, past_due_amount: c.past_due_amount },
        });
        break;
      }
      case "mortgage": {
        const m = p as Plaid.MortgageLiability;
        Object.assign(base, {
          minimum_due: m.next_monthly_payment ?? null,
          due_date: m.next_payment_due_date ?? null,
          apr_percent: m.interest_rate?.percentage ?? null,
          last_payment_amount: m.last_payment_amount ?? null,
          last_payment_date: m.last_payment_date ?? null,
          extra: { rate_type: m.interest_rate?.type, escrow_balance: m.escrow_balance, maturity_date: m.maturity_date, past_due_amount: m.past_due_amount, ytd_interest_paid: m.ytd_interest_paid, ytd_principal_paid: m.ytd_principal_paid },
        });
        break;
      }
      case "student": {
        const s = p as Plaid.StudentLoan;
        Object.assign(base, {
          statement_balance: s.last_statement_balance ?? null,
          statement_date: s.last_statement_issue_date ?? null,
          minimum_due: s.minimum_payment_amount ?? null,
          due_date: s.next_payment_due_date ?? null,
          apr_percent: s.interest_rate_percentage ?? null,
          is_overdue: s.is_overdue ?? null,
          last_payment_amount: s.last_payment_amount ?? null,
          last_payment_date: s.last_payment_date ?? null,
          extra: { expected_payoff_date: s.expected_payoff_date, outstanding_interest_amount: s.outstanding_interest_amount, loan_status: s.loan_status?.type },
        });
        break;
      }
      case "loan": {
        const l = p as Plaid.LoanLiability;
        Object.assign(base, {
          minimum_due: l.next_payment_amount ?? null,
          due_date: l.next_payment_due_date ?? null,
          apr_percent: l.interest_rate?.percentage ?? null,
          last_payment_amount: l.last_payment_amount ?? null,
          last_payment_date: l.last_payment_date ?? null,
          extra: { principal_balance: l.principal_balance, payoff_amount: l.payoff_amount, maturity_date: l.maturity_date, payment_frequency: l.payment_frequency },
        });
        break;
      }
    }
    out.push(base);
  }
  return out.sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
}
