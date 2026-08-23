// The recording half of card-benefit tracking (Brief 05, phase 2): which
// transactions a benefit's match rules hit, and which cb_usage row each one
// belongs to.
//
// Split out of routes.js and I/O-free in the same sense periods.js is: every
// database call arrives through the injected `io` object (routes.js passes
// repository.js's), so the part of this feature most likely to be wrong — where
// a statement credit that posts a cycle late actually lands — is unit-testable
// without a database (test/benefitSync.test.js).
//
// The rule that shapes everything below: a qualifying CHARGE and the posted
// statement CREDIT that confirms it are two transactions describing ONE use of
// the benefit, and they are usually in different periods (periods.js's note on
// statement-credit lag). File the credit where it landed and two things break at
// once — the charge's period stays `used-unconfirmed` forever because nothing
// ever revisits it, and the new period reads `used` off the previous period's
// money, consuming an allowance nobody has spent and suppressing the alert the
// owner actually needs.
import {
  recentPeriods, toDateString, addDaysIso, isRollupRow, ROLLUP_TXN_PREFIX,
} from "./periods.js";

// How far back a sync re-examines periods that have already closed.
//
// 120 days ≈ four monthly billing cycles. A posted credit typically lands one
// cycle after its charge, occasionally two (a charge late in a cycle, a credit
// that posts after the following statement closes), so four cycles is comfortable
// cover with room for a Plaid backfill that arrives late. It is also the cost
// knob: every extra period is another pass of every rule over the transaction
// table, which is why this is bounded rather than "since the card was opened".
export const CREDIT_LOOKBACK_DAYS = 120;

// How far PAST a period's end a credit-direction rule keeps looking for the
// credit that settles a charge inside that period. 45 days covers a full
// statement cycle plus the posting delay, so a December credit for a November
// charge is still found while November is being re-synced.
export const CREDIT_GRACE_DAYS = 45;

// How close a posted credit's amount has to be to a recorded charge's for the
// two to be the same use of the benefit. Amounts are NUMERIC(12,2) round-tripped
// through floats, so exact equality is not safe; two cents absorbs that on both
// sides while staying far too small to conflate two genuinely different charges.
export const CREDIT_AMOUNT_TOLERANCE = 0.02;

// Below half a cent there is no rollup worth recording — and a zero-amount row
// must never be written, because it would make an untouched period read as
// partially-used instead of available.
const ROLLUP_MIN = 0.005;

// One rollup row per rule per period (see periods.js and schema.js).
const rollupTxnId = (ruleId) => `${ROLLUP_TXN_PREFIX}rule:${ruleId}`;

const ruleDirection = (rule) => (rule?.direction === "credit" ? "credit" : "charge");

// A rule with no criteria at all matches the entire statement, which would
// silently mark every benefit used. Skipped rather than obeyed.
const hasCriteria = (rule) =>
  Boolean(rule.merchant_regex) || rule.amount_min != null || rule.amount_max != null || Boolean(rule.category);

// Charge rules run over EVERY period before any credit rule runs over any of
// them. On a first sync both halves of a pair are discovered in the same pass,
// and a credit-direction rule looks past its period's end — so a July rule can
// reach a September credit whose charge is in August. Pairing that credit before
// August's charge exists would find nothing to confirm and file the credit as
// fresh usage, which is precisely the bug this module is built to avoid.
const DIRECTION_ORDER = ["charge", "credit"];

const containingPeriod = (periods, date) =>
  periods.find((p) => date && p.start && date >= p.start && (!p.end || date <= p.end)) || null;

// The recorded charge a posted credit settles, or null.
//
// Deliberately narrow: an automatic row for a real transaction, in one of the
// periods this sync is looking at, not already confirmed by some other credit,
// dated on or before the credit (a credit cannot settle a charge that has not
// happened), and matching on amount within CREDIT_AMOUNT_TOLERANCE. The most
// recent qualifying charge wins — a credit settles the charge it followed.
function chargeToConfirm(rows, { amount, date, periodKeys }) {
  const candidates = rows.filter((row) => {
    if (row.source !== "auto" || !row.txn_id || isRollupRow(row)) return false;
    if (row.confirmed_at || row.confirmed_txn_id) return false;
    if (!periodKeys.has(row.period_key)) return false;
    const rowDay = toDateString(row.date);
    if (date && rowDay && rowDay > date) return false;
    return Math.abs(Math.abs(Number(row.amount) || 0) - amount) <= CREDIT_AMOUNT_TOLERANCE;
  });
  candidates.sort((a, b) => String(toDateString(a.date) || "").localeCompare(String(toDateString(b.date) || "")));
  return candidates[candidates.length - 1] || null;
}

// Runs every benefit's match rules over its recent periods and records what they
// hit in cb_usage. Safe to call on every status read: upsertUsage keys on
// (benefit, period, transaction) and every confirmation is stamped with the
// credit that produced it, so re-running re-writes the same rows rather than
// accumulating usage.
//
// Returns { written, ruleErrors }: the number of rows touched, so the caller
// only re-reads usage when something actually changed, and one entry per match
// rule that FAILED to run. A failed rule is not a benefit with no usage — see
// the `rule-error` status in periods.js.
export async function syncUsage(cards = [], usageRows = [], today, io = {}) {
  const { findMatches, sumMatches, upsertUsage, confirmUsage, deleteUsage } = io;

  // An anchored cycle (months_n) is measured from the last recorded use, so the
  // anchor has to come out of the existing usage rows before its period can be
  // resolved at all.
  const lastUseByBenefit = new Map();
  // A working copy per benefit, kept up to date as rows are written, so a charge
  // recorded moments ago in this same pass can still be confirmed by a credit
  // found later in it.
  const rowsByBenefit = new Map();
  for (const row of usageRows) {
    const id = String(row.benefit_id);
    if (!rowsByBenefit.has(id)) rowsByBenefit.set(id, []);
    rowsByBenefit.get(id).push({ ...row });
    const date = toDateString(row.date);
    if (!date) continue;
    const current = lastUseByBenefit.get(row.benefit_id);
    if (!current || date > current) lastUseByBenefit.set(row.benefit_id, date);
  }

  let written = 0;
  const ruleErrors = [];

  for (const card of cards) {
    // No linked Plaid account means no transactions to match against. The
    // benefit still evaluates — as insufficient-history, since we can see
    // nothing — it just cannot match automatically.
    if (!card.account_id) continue;
    for (const benefit of card.benefits || []) {
      if (!benefit.rules?.length) continue;

      let periods;
      try {
        periods = recentPeriods({
          unit: benefit.period_unit,
          count: benefit.period_count,
          basis: benefit.period_basis,
          anniversaryDate: card.anniversary_date,
          anchorDate: benefit.period_unit === "months_n" ? lastUseByBenefit.get(benefit.id) || null : null,
        }, today, CREDIT_LOOKBACK_DAYS);
      } catch (err) {
        console.error(`benefits: benefit ${benefit.id} period unresolved:`, err.message);
        continue;
      }

      const rows = rowsByBenefit.get(String(benefit.id)) || [];
      rowsByBenefit.set(String(benefit.id), rows);
      const periodKeys = new Set(periods.map((p) => p.key));

      for (const direction of DIRECTION_ORDER) {
        const rules = benefit.rules.filter((rule) => ruleDirection(rule) === direction && hasCriteria(rule));
        // Oldest period first, so a charge is always on the books before the
        // credit that confirms it is considered. recentPeriods returns newest
        // first because that is the order a reader wants; this loop does not.
        for (const period of [...periods].reverse()) {
          for (const rule of rules) {
            const conditions = {
              accountId: card.account_id,
              merchantRegex: rule.merchant_regex,
              amountMin: rule.amount_min,
              amountMax: rule.amount_max,
              category: rule.category,
              direction,
            };
            // An anchored cycle that is available again has no end; everything up
            // to today is in scope.
            const periodEnd = period.end || today;
            // Credits are searched past the period's end, because that is where a
            // credit for a charge inside this period actually posts. Money is
            // still only ever SUMMED over the period itself (see the rollup below)
            // — the grace tail is for finding the credit, not for moving spend
            // into the period.
            const scanEnd = direction === "credit" && period.end
              ? addDaysIso(period.end, CREDIT_GRACE_DAYS)
              : periodEnd;

            let found;
            try {
              found = await findMatches({ ...conditions, startDate: period.start, endDate: scanEnd });
            } catch (err) {
              // A stored regex that no longer parses must not take down the status
              // read for every other benefit on the card — but it must not pass
              // for "nothing matched" either, so it is reported rather than only
              // logged.
              console.error(`benefits: rule ${rule.id} skipped:`, err.message);
              ruleErrors.push({ benefit_id: benefit.id, rule_id: rule.id, message: err.message });
              continue;
            }

            for (const txn of found.rows) {
              const txnDate = toDateString(txn.date);
              const amount = Math.abs(Number(txn.amount) || 0);

              if (direction === "credit") {
                // Already accounted for: filed as its own row, or already spent
                // confirming a charge on a previous run. Either way it is one use
                // of the benefit and must not be counted a second time.
                if (rows.some((r) => r.txn_id === txn.id || r.confirmed_txn_id === txn.id)) continue;

                const charge = chargeToConfirm(rows, { amount, date: txnDate, periodKeys });
                if (charge) {
                  // The authoritative half of the pair, attached to the period of
                  // the charge it settles rather than to the period it posted in.
                  const confirmedAt = new Date();
                  await confirmUsage({ usageId: charge.id, confirmedAt, confirmedTxnId: txn.id });
                  charge.confirmed_at = confirmedAt;
                  charge.confirmed_txn_id = txn.id;
                  written++;
                  continue;
                }
              }

              // Charge-direction matches are filed by their own date, which the
              // scan window already guarantees is inside this period. A credit
              // with no charge to confirm — a benefit matched only on its posted
              // credit — is filed under the period it landed in.
              const target = direction === "credit"
                ? containingPeriod(periods, txnDate) || period
                : period;
              const confirmedAt = direction === "credit" ? new Date() : null;
              const saved = await upsertUsage({
                benefitId: benefit.id,
                periodKey: target.key,
                amount,
                txnId: txn.id,
                source: "auto",
                confirmedAt,
              });
              written++;
              // The working copy tracks the row rather than gaining a second
              // entry for it: two entries for one charge would let two different
              // credits each think they had an unconfirmed charge to settle.
              const already = rows.find((r) => r.period_key === target.key && r.txn_id === txn.id);
              if (already) {
                already.amount = amount;
                already.confirmed_at = already.confirmed_at || confirmedAt;
              } else {
                rows.push({
                  id: saved?.id ?? null,
                  benefit_id: benefit.id,
                  period_key: target.key,
                  amount,
                  txn_id: txn.id,
                  source: "auto",
                  confirmed_at: confirmedAt,
                  confirmed_txn_id: null,
                  date: txnDate,
                });
              }
            }

            // ── The money the sample does not carry ──────────────────────────
            // findMatches is bounded (limits.js); the amount is not. When a rule
            // hits more transactions than the sample holds, the rest is summed in
            // Postgres — exact, unbounded, and materialising no rows — and parked
            // on one rollup row for the period, so `amount_used` never depends on
            // how many rows were fetched. Without it a heavily-used credit reports
            // partially-used, or available, which is the failure this feature
            // exists to prevent.
            //
            // An untruncated sample IS the whole matching set (limits.js proves it
            // by fetching one row more than it keeps), and every row in it has just
            // been recorded individually, so there is nothing left to roll up.
            const rollupTxn = rollupTxnId(rule.id);
            const existingRollup = rows.find((r) => r.period_key === period.key && r.txn_id === rollupTxn);
            let unlisted = { total: 0, count: 0 };
            if (found.truncated) {
              const accounted = new Set();
              for (const row of rows) {
                if (row.period_key === period.key && row.txn_id && !isRollupRow(row)) accounted.add(row.txn_id);
                // A credit spent confirming a charge is accounted for by that
                // charge's row, in that charge's period.
                if (row.confirmed_txn_id) accounted.add(row.confirmed_txn_id);
              }
              unlisted = await sumMatches({
                ...conditions,
                startDate: period.start,
                endDate: periodEnd,
                excludeTxnIds: [...accounted],
              });
            }

            if (unlisted.total > ROLLUP_MIN) {
              await upsertUsage({
                benefitId: benefit.id,
                periodKey: period.key,
                amount: unlisted.total,
                txnId: rollupTxn,
                source: "auto",
                confirmedAt: direction === "credit" ? new Date() : null,
                note: `${unlisted.count} further matching transaction${unlisted.count === 1 ? "" : "s"} beyond the recorded sample`,
              });
              written++;
              if (existingRollup) existingRollup.amount = unlisted.total;
              else rows.push({
                id: null, benefit_id: benefit.id, period_key: period.key, amount: unlisted.total,
                txn_id: rollupTxn, source: "auto", confirmed_at: null, confirmed_txn_id: null, date: periodEnd,
              });
            } else if (existingRollup) {
              // Everything this rule matches is now recorded row by row; a rollup
              // left behind from an earlier, truncated run would double-count.
              await deleteUsage(benefit.id, period.key, rollupTxn);
              rows.splice(rows.indexOf(existingRollup), 1);
              written++;
            }
          }
        }
      }
    }
  }

  return { written, ruleErrors };
}
