// Deriving benefit usage from transactions, on read (Brief 05, phase 2 rebuild
// — see docs/feature-briefs/05-derive-on-read-plan.md).
//
// The stored-usage model this replaces persisted derived state (matched rows,
// rollups, confirmations) and then had to keep it consistent as rules,
// transactions and periods changed. It could not: every defect it shipped —
// a confirmed charge dropped from the total, an annual lookback that never
// reached the prior period, orphaned rollups, stale rows, double-counting
// across overlapping rules — was drift between the store and the truth.
//
// So nothing here is persisted. Auto-matched usage is a pure function of
// (transactions, match rules, period spec, as-of date), and so is credit-to-
// charge pairing. Both are recomputed on every read. Pairing is safe to derive
// because it is deterministic over a total order (date, txn id): the same
// inputs always produce the same pairing, and nothing persisted depends on it,
// so new backfill data producing a different pairing is simply a better answer.
//
// Like periods.js this module is I/O-free — no pg, no express, no clock of its
// own — so the two things most likely to be wrong (which credit settles which
// charge, and what that adds up to) are unit-testable without a database
// (test/benefitDerive.test.js).
import {
  resolvePeriod, recentPeriods, toDateString, addDaysIso, hasCriteria,
  cycleAnchorFor, benefitUnit, isCountUnit, isManualUnit,
} from "./periods.js";

// How far back a read looks for the charge a lagging statement credit settles.
//
// 120 days ≈ four monthly billing cycles. A posted credit typically lands one
// cycle after its charge, occasionally two, so four cycles is comfortable cover
// with room for a Plaid backfill that arrives late. It is also the cost knob:
// every extra period widens the single transaction scan.
//
// For periods LONGER than 120 days the days are not what matters — see the
// minPrevious floor in recentPeriods, which is what puts the December charge in
// scope when its January credit is attributed.
export const LOOKBACK_DAYS = 120;

// Rows per (benefit, direction) the pairing pass will hold. Pairing needs the
// individual transactions — it is the one part of this module that cannot be
// done in aggregate — so it has to be bounded like every other query in this
// app (limits.js: production is a 256 MB VM).
//
// Overflowing this cap is reported as `rule-error` rather than silently paired
// over a subset. Unreliable standalone-vs-paired classification does not degrade
// gracefully: it can inflate amount_used and suppress the expiry alert the owner
// needs. A rule matching 2,000+ transactions in the scan window is a rule that
// wants narrowing, and saying so is the honest answer.
export const PAIRING_ROW_LIMIT = 2000;

// Transactions listed individually in `matches`. A display cap only —
// `amount_used` is summed in SQL over the whole period and never from this list
// — and `matches_truncated` says when the list is a sample, exactly as the
// contract promises.
export const MATCHES_DISPLAY_LIMIT = 200;

// How close a posted credit's amount has to be to a charge's for the exact pass
// to call them the same use. Amounts are NUMERIC(12,2) round-tripped through
// floats, so exact equality is not safe; two cents absorbs that on both sides
// while staying far too small to conflate two genuinely different charges.
export const PAIR_AMOUNT_TOLERANCE = 0.02;

// How far a charge may be dated AFTER the credit that settles it and still be
// considered the charge that credit belongs to.
//
// A credit lags its charge by a cycle, so the ordinary case is charge first.
// But the two dates come from different clocks: `t.date` is whatever the issuer
// stamped on the row, and a charge often carries its STATEMENT date while the
// credit carries its POST date (or the reverse), so a small inversion — a
// credit posting a day or two before the charge it refunds — is a normal
// artefact rather than evidence they are unrelated. With a strict
// charge <= credit test that credit can never pair, and it falls through to
// residue as standalone usage of its own period: $100 of charge plus $100 of
// credit reported as $200 used, the exact double-count pairing exists to stop.
//
// Deliberately a few days and not more. The window is a reach FORWARD in time,
// and a credit that can reach far enough forward will pair with a genuinely
// later, unrelated charge and silently confirm money nobody has been refunded.
export const PAIR_DATE_SKEW_DAYS = 5;

// Half a cent: below this there is no money left to attribute, and chasing
// float residue would leave one-cent "standalone credits" behind every pairing.
const EPSILON = 0.005;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// The anniversary base is the BENEFIT's cycle_anchor when it has one and the
// card's anniversary_date otherwise — cycleAnchorFor, imported rather than
// re-expressed, because periods.js#evaluateBenefit asks the same question and
// the two must not be able to disagree. A window scanned here and a window
// reported there would measure an amount against a period nobody asked about.
const periodSpec = (benefit, card, anchorDate = null) => ({
  unit: benefit.period_unit,
  count: benefit.period_count,
  basis: benefit.period_basis,
  anniversaryDate: cycleAnchorFor(benefit, card),
  anchorDate,
});

// ── Windows ───────────────────────────────────────────────────────────────────

// The scan windows one status read needs, plus the plan that says which window
// is whose.
//
// Every benefit gets a plan — including a benefit with no rules and a card with
// no linked Plaid account — because the response has to carry a resolved period
// for all of them. Only benefits that could actually match get a WINDOW, so the
// transaction scan is not widened by rows that can never join.
//
// Returns { windows, plans }:
//   windows  [{ benefit_id, period_key, start_date, end_date }], the tuples the
//            SQL unnests. Contiguous and non-overlapping per benefit.
//   plans    [{ benefitId, benefit, card, periods, anchored }] in catalog order.
export function buildWindows(cards = [], today, { lookbackDays = LOOKBACK_DAYS, excludedRuleIds = [] } = {}) {
  const asOf = toDateString(today);
  if (!asOf) throw new Error("buildWindows requires today as YYYY-MM-DD");
  const excluded = new Set((excludedRuleIds || []).map((id) => String(id)));

  const windows = [];
  const plans = [];
  for (const card of cards) {
    for (const benefit of card.benefits || []) {
      const anchored = benefit.period_unit === "months_n";
      let periods;
      try {
        // An anchored cycle's window depends on its anchor, and the anchor is
        // the most recent USE — which is exactly what this read is trying to
        // find out. So the scan window is the trailing `len` months ending
        // today, and the real period is resolved from the matched rows in
        // deriveBenefitStats. `resolvePeriod` with no anchor returns precisely
        // that trailing span (see resolveAnchored).
        periods = anchored
          ? [resolvePeriod(periodSpec(benefit, card, null), asOf)]
          : recentPeriods(periodSpec(benefit, card, null), asOf, lookbackDays, { minPrevious: 1 });
      } catch (err) {
        console.error(`benefits: benefit ${benefit.id} period unresolved:`, err.message);
        continue;
      }
      plans.push({ benefitId: String(benefit.id), benefit, card, periods, anchored });

      if (!card.account_id) continue;
      const usable = (benefit.rules || []).filter((r) => hasCriteria(r) && !excluded.has(String(r.id)));
      if (usable.length === 0) continue;
      for (const period of periods) {
        if (!period.start) continue;
        windows.push({
          benefit_id: benefit.id,
          period_key: period.key,
          start_date: period.start,
          // An anchored cycle that is available again has no end; everything up
          // to today is in scope.
          end_date: period.end || asOf,
        });
      }
    }
  }
  return { windows, plans };
}

// ── Pairing ───────────────────────────────────────────────────────────────────

// Which posted statement credit settles which qualifying charge.
//
// A charge and the credit that confirms it are two transactions describing ONE
// use of the benefit, usually a cycle apart. Summing both double-counts; filing
// the credit as usage of the period it landed in consumes an allowance nobody
// spent and suppresses the alert the owner needs. So a credit is spent against
// charges, and only what is LEFT of it is money of its own.
//
// Deterministic by construction: a total order on (date, txn_id), no clock, no
// randomness, no dependence on the order rows came back from Postgres. Shuffle
// the input and the output is identical.
//
// Takes { charges, credits } as `{ txn_id, date, amount, period_key }` with
// positive amounts, and returns the same rows annotated:
//   charges  + `confirmed`  dollars of this charge a credit has settled
//   credits  + `standalone` dollars of this credit no charge accounts for
export function pairCreditsToCharges({ charges = [], credits = [] } = {}) {
  const order = (a, b) =>
    String(a.date).localeCompare(String(b.date)) || String(a.txn_id).localeCompare(String(b.txn_id));

  const chargeState = [...charges].sort(order).map((c) => ({ ...c, amount: Math.abs(num(c.amount)), confirmed: 0 }));
  const creditState = [...credits].sort(order).map((c) => ({ ...c, amount: Math.abs(num(c.amount)), standalone: 0 }));

  // A charge settles a credit when the charge came FIRST — that is the normal
  // direction, and the credit is its reimbursement. The skew window exists only
  // because the two dates come off different clocks (statement date vs post
  // date), so a charge dated a little AFTER its credit can still be the same
  // event.
  //
  // The window is a FALLBACK, never a peer. Selection below takes the latest
  // qualifying charge, so admitting forward charges as equal candidates let an
  // unrelated later charge outrank the true earlier one, and let a credit reach
  // across a period boundary to confirm the next period's spend — the
  // mis-attribution this whole model exists to prevent. Preceding charges are
  // therefore always exhausted first, and the window is consulted only when
  // nothing precedes.
  //
  // A row with no date at all stays eligible, as it always was; the total order
  // still decides which is picked, so the result stays deterministic.
  const precedes = (charge, credit) =>
    !credit.date || !charge.date || charge.date <= credit.date;
  const withinSkew = (charge, credit) =>
    !credit.date || !charge.date || charge.date <= addDaysIso(credit.date, PAIR_DATE_SKEW_DAYS);

  // Pass 1 — EXACT. For each credit oldest first, the latest untouched charge
  // it may settle (see `settles`) whose amount matches within tolerance. Run
  // before the partial pass so a $15 credit that exactly settles a $15 charge
  // takes that charge rather than being spread across a $4 and an $11 that
  // happen to sit nearer the credit.
  const remaining = [];
  for (const credit of creditState) {
    const pickFrom = (eligible) => {
      let found = null;
      for (const charge of chargeState) {
        if (charge.confirmed > 0 || !eligible(charge, credit)) continue;
        if (Math.abs(charge.amount - credit.amount) > PAIR_AMOUNT_TOLERANCE) continue;
        found = charge; // ascending order, so the last qualifying charge is the latest
      }
      return found;
    };
    // Preceding charges first; the skew window only if none precedes.
    const pick = pickFrom(precedes) || pickFrom(withinSkew);
    if (pick) {
      // A credit settles the charge it followed, in full.
      pick.confirmed = pick.amount;
      continue;
    }
    remaining.push(credit);
  }

  // Pass 2 — PARTIAL / AGGREGATE. What is left of each credit is spent against
  // the charges it may settle, newest-first, taking each charge's
  // still-unconfirmed remainder.
  // This is what handles $50 of a $100 charge, and one $15 credit covering a $4
  // and an $11.
  //
  // Not optional. With exact-only pairing an amount-mismatched credit falls
  // through to residue and becomes standalone usage of ITS OWN period — which
  // is the annual bug (a January credit spending January's allowance for a
  // December charge) reintroduced through the side door.
  // Preceding charges newest-first (nearest the credit), then any the skew
  // window admits, nearest-first — same fallback ordering as pass 1.
  const candidatesFor = (credit) => {
    const pre = [];
    const skewed = [];
    for (const charge of chargeState) {
      if (precedes(charge, credit)) pre.push(charge);
      else if (withinSkew(charge, credit)) skewed.push(charge);
    }
    return [...pre.reverse(), ...skewed];
  };
  for (const credit of remaining) {
    let left = credit.amount;
    for (const charge of candidatesFor(credit)) {
      if (left <= EPSILON) break;
      const room = charge.amount - charge.confirmed;
      if (room <= EPSILON) continue;
      const take = Math.min(room, left);
      charge.confirmed += take;
      left -= take;
    }
    // Pass 3 — RESIDUE. Whatever no charge could absorb is standalone usage of
    // the period this credit landed in, confirmed by nature: the statement
    // credit itself is the evidence. The only path by which a credit counts as
    // money, and the reason a benefit matched ONLY on its posted credit still
    // reports an amount.
    credit.standalone = left > EPSILON ? round2(left) : 0;
  }

  for (const charge of chargeState) charge.confirmed = round2(Math.min(charge.confirmed, charge.amount));
  return { charges: chargeState, credits: creditState };
}

// ── Per-benefit statistics ────────────────────────────────────────────────────

// Turns the two transaction queries and the manual marks into the per-benefit
// figures periods.js#evaluateBenefits needs for the CURRENT period.
//
//   plans        from buildWindows
//   aggregates   [{ benefit_id, period_key, is_credit, total, count, last_date }]
//                — exact money, summed in SQL over the whole period
//   rows         [{ benefit_id, period_key, txn_id, date, merchant, amount,
//                   is_credit }] — bounded candidates, for pairing and display
//   marks        [{ benefit_id, period_key, amount, note, created_at }]
//
// Returns { [benefit_id]: { period, amountUsed, confirmedTotal, matchCount,
//                           matches, matchesTruncated, manual, overflow } }.
export function deriveBenefitStats({ plans = [], aggregates = [], rows = [], marks = [] } = {}, today) {
  const asOf = toDateString(today);
  if (!asOf) throw new Error("deriveBenefitStats requires today as YYYY-MM-DD");

  const rowsByBenefit = groupBy(rows, (r) => String(r.benefit_id));
  const marksByBenefit = groupBy(marks, (m) => String(m.benefit_id));
  const aggIndex = new Map();
  for (const a of aggregates) {
    aggIndex.set(`${a.benefit_id}\x00${a.period_key}\x00${a.is_credit ? "c" : "d"}`, a);
  }

  const stats = {};
  for (const plan of plans) {
    stats[plan.benefitId] = deriveOne(plan, {
      rows: rowsByBenefit.get(plan.benefitId) || [],
      marks: marksByBenefit.get(plan.benefitId) || [],
      aggIndex,
      asOf,
    });
  }
  return stats;
}

function groupBy(items, key) {
  const out = new Map();
  for (const item of items) {
    const k = key(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

function deriveOne(plan, { rows, marks, aggIndex, asOf }) {
  const { benefit, card, anchored } = plan;

  // Defensive dedupe by txn_id. The SELECT DISTINCT in fetchMatchRows already
  // guarantees a transaction matched by two overlapping rules (DOORDASH and
  // DOOR) appears once, but the invariant that the SAME transaction is never
  // paired twice is the one that keeps amount_used honest, so it is enforced
  // here too where a unit test can reach it.
  const seen = new Set();
  const deduped = [];
  for (const row of [...rows].sort(byDateThenId)) {
    const id = String(row.txn_id);
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push({
      txn_id: row.txn_id,
      period_key: row.period_key,
      date: toDateString(row.date),
      merchant: row.merchant ?? null,
      amount: Math.abs(num(row.amount)),
      is_credit: Boolean(row.is_credit),
    });
  }

  // Overflow is measured on the RAW rows, per direction, because that is what
  // the SQL capped: fetchMatchRows asks for one row more than the limit per
  // (benefit, direction) exactly so this question has an exact answer
  // (limits.js' one-extra-row idiom).
  const rawCharges = rows.filter((r) => !r.is_credit).length;
  const rawCredits = rows.filter((r) => r.is_credit).length;
  const overflow = rawCharges > PAIRING_ROW_LIMIT || rawCredits > PAIRING_ROW_LIMIT
    ? `a match rule for this benefit matches more than ${PAIRING_ROW_LIMIT} transactions in the evaluation window; narrow the rule`
    : null;

  const { charges, credits } = pairCreditsToCharges({
    charges: deduped.filter((r) => !r.is_credit),
    credits: deduped.filter((r) => r.is_credit),
  });

  // The current period. For an anchored cycle the anchor IS the most recent
  // recorded use, so it can only be known now: the latest matched transaction
  // or manual mark inside the trailing scan window.
  const scan = plan.periods[0];
  let period = scan;
  if (anchored) {
    const inWindow = (d) => d && scan.start && d >= scan.start && (!scan.end || d <= scan.end) && d <= asOf;
    const dates = [
      ...deduped.map((r) => r.date),
      ...marks.map((m) => toDateString(m.created_at)),
    ].filter(inWindow).sort();
    period = resolvePeriod(periodSpec(benefit, card, dates.pop() || null), asOf);
  }

  // Which rows and which mark belong to the current period.
  //
  // Anchored cycles select by DATE, not by key: a mark recorded under the
  // "anchor:...:none" key becomes the anchor of the very next evaluation, at
  // which point the key changes, and a key-equality filter would lose the very
  // row that defined the period.
  const inPeriod = anchored
    ? (r) => r.date && period.start && r.date >= period.start && (!period.end || r.date <= period.end)
    : (r) => r.period_key === period.key;

  const periodCharges = charges.filter(inPeriod);
  const periodCredits = credits.filter(inPeriod);

  const mark = anchored
    ? marks.find((m) => {
        const d = toDateString(m.created_at);
        return d && period.start && d >= period.start && (!period.end || d <= period.end);
      }) || null
    : marks.find((m) => m.period_key === period.key) || null;

  // ── The money ───────────────────────────────────────────────────────────────
  // Charge dollars come from the SQL aggregate, never from the rows above: the
  // rows are a bounded sample and the aggregate is the exact total for the
  // period. This is the rollup concept, surviving as arithmetic with no stored
  // row left to orphan.
  const chargeAgg = aggIndex.get(`${benefit.id}\x00${period.key}\x00d`);
  const creditAgg = aggIndex.get(`${benefit.id}\x00${period.key}\x00c`);
  // ...except for an anchored cycle, whose period is a slice of the scan window
  // chosen after the aggregate was computed, so no aggregate bucket describes
  // it. Its figure comes from the rows — sound here because the rows are the
  // complete matching set whenever `overflow` is null, and `overflow` is
  // reported as rule-error rather than as a number.
  const chargeTotal = anchored
    ? periodCharges.reduce((sum, c) => sum + c.amount, 0)
    : num(chargeAgg?.total);
  const standaloneTotal = periodCredits.reduce((sum, c) => sum + num(c.standalone), 0);

  // ── How usage is MEASURED, which is the benefit's unit's business ───────────
  //
  // `usd` is the original behaviour and the default: charges and the credits
  // paired to them are NEVER summed — a paired credit contributes only to
  // confirmedTotal. That is what makes the dropped-charge regression
  // impossible: there is no per-row confirmed-vs-charging bucket for a stamped
  // charge to fall out of, and a charge always carries its amount.
  //
  // `visits` / `count` measure ROWS instead. A 10-visit allowance with three
  // matching transactions is 3 of 10, not the $3-ish their amounts happen to
  // add up to, so the aggregate's COUNT is read where the SUM is read for
  // dollars — a branch, not a second query. Only CHARGES are counted: a posted
  // credit is the same event as the charge it settles, so counting it too would
  // record one lounge visit twice, exactly as summing both would double-count
  // one dollar. An unpaired credit is not a visit of its own either — there is
  // no "standalone visit" a refund could represent — so residue adds nothing
  // here.
  //
  // `points` measures NOTHING automatically. A transaction amount is
  // denominated in dollars, and folding dollars into a points allowance is a
  // category error rather than an approximation: $250 of spend is not 250
  // points, and this app holds no rate to convert it with. So the matched
  // transactions stay in `matches` as evidence and contribute zero, and with no
  // manual mark periods.js reports the benefit `manual-only`.
  const denomination = benefitUnit(benefit.unit);
  let amountUsed;
  let confirmedTotal;
  if (isManualUnit(denomination)) {
    amountUsed = 0;
    confirmedTotal = 0;
  } else if (isCountUnit(denomination)) {
    // From the aggregate for the same reason the dollar total is: the rows are
    // a bounded sample, the aggregate is the exact answer for the period. (An
    // anchored cycle has no aggregate bucket for its window — see above — so it
    // counts the rows, which are complete whenever `overflow` is null.)
    amountUsed = anchored ? periodCharges.length : num(chargeAgg?.count);
    // The count-shaped reading of "every counted unit has a posted credit
    // behind it": how many of the counted charges are fully settled.
    confirmedTotal = periodCharges.filter((c) => num(c.confirmed) + EPSILON >= c.amount).length;
  } else {
    amountUsed = round2(chargeTotal + standaloneTotal);
    confirmedTotal = round2(
      periodCharges.reduce((sum, c) => sum + num(c.confirmed), 0) + standaloneTotal
    );
  }

  // Every matched transaction in the period, charges and credits alike, in
  // date order — the credit is evidence even when its money belongs to an
  // earlier period.
  const listed = [...periodCharges, ...periodCredits].sort(byDateThenId);
  const matchCount = anchored
    ? listed.length
    : num(chargeAgg?.count) + num(creditAgg?.count);
  const matches = listed.slice(0, MATCHES_DISPLAY_LIMIT).map((r) => ({
    txn_id: r.txn_id,
    date: r.date,
    merchant: r.merchant,
    amount: r.amount,
  }));

  return {
    period,
    amountUsed,
    confirmedTotal,
    matchCount,
    matches,
    matchesTruncated: matchCount > matches.length,
    manual: mark
      ? { amount: num(mark.amount), note: mark.note ?? null, date: toDateString(mark.created_at) }
      : null,
    overflow,
  };
}

const byDateThenId = (a, b) =>
  String(a.date).localeCompare(String(b.date)) || String(a.txn_id).localeCompare(String(b.txn_id));
