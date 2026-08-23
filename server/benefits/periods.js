// Card-benefit period math and evaluation (Brief 05, phase 2).
//
// Deliberately I/O-free — no pg, no express, no clock of its own — the same
// split limits.js and geminiUsage.js use, so the part of this feature most
// likely to be wrong (which window a benefit is in, and whether we are entitled
// to call it unused) is unit-testable without a database
// (test/benefitPeriods.test.js).
//
// Two rules run through everything below:
//
//   1. All date arithmetic is done on UTC date PARTS — {y, m, d} tuples and
//      Date.UTC() — never on a local `new Date("2026-08-23")` plus milliseconds.
//      Local parsing and local getters shift by the machine's offset and drift a
//      whole day across a DST boundary, which on a month-end period silently
//      moves the reset by one day.
//   2. Nothing here may report `available` for a window we have no transaction
//      history for. `insufficient-history` exists precisely so an unseen window
//      reads as unseen rather than as unused.

// ── Date parts (UTC only) ─────────────────────────────────────────────────────

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

// Accepts what pg hands back (a Date for DATE columns unless the query casts
// with TO_CHAR) as well as an already-formatted string, and returns YYYY-MM-DD
// or null. Date → ISO goes through toISOString(), which is UTC by definition.
export function toDateString(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = String(value);
  return ISO_DATE_RE.test(s) ? s.slice(0, 10) : null;
}

function parts(value) {
  const s = toDateString(value);
  if (!s) return null;
  const m = ISO_DATE_RE.exec(s);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

const iso = ({ y, m, d }) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (y, m) => (m === 2 && isLeapYear(y) ? 29 : MONTH_DAYS[m - 1]);

// Absolute month number counted from year 0, so it is never negative for a real
// date and Math.floor() divides it the way calendar tiling expects.
const monthIndex = ({ y, m }) => y * 12 + (m - 1);
const monthStart = (idx) => ({ y: Math.floor(idx / 12), m: (idx % 12) + 1, d: 1 });

const utcMs = ({ y, m, d }) => Date.UTC(y, m - 1, d);
const daysBetween = (a, b) => Math.round((utcMs(b) - utcMs(a)) / 86400000);

function addDays(p, n) {
  const dt = new Date(utcMs(p) + n * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// Month arithmetic with end-of-month clamping, ALWAYS applied to the original
// base rather than to the previous result. That is what keeps two traps from
// biting:
//
//   - Jan 31 + 1 month is Feb 28 (or 29), not Mar 3. JavaScript's
//     Date.setMonth() overflows into the next month instead of clamping.
//   - A Feb 29 anniversary lands on Feb 28 in a non-leap year, but +48 months
//     from the SAME base is Feb 29 again. Clamping iteratively (Feb 29 → Feb 28
//     → Feb 28 …) would permanently walk the anniversary a day earlier, which
//     over a card's life is exactly the silent drift this feature cannot have.
function addMonths(base, n) {
  const idx = monthIndex(base) + n;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return { y, m, d: Math.min(base.d, daysInMonth(y, m)) };
}

const isAfter = (a, b) => iso(a) > iso(b);

// ── Period length ─────────────────────────────────────────────────────────────
// Everything is expressed in months, which is the only unit all five period
// shapes share. `count` multiplies the unit (a 2-month credit is
// { unit: "month", count: 2 }); for `months_n` the count IS the month span.
const UNIT_MONTHS = { month: 1, quarter: 3, half: 6, year: 12 };

// A junk or missing count is 1, never NaN: a NaN span would make every period
// boundary NaN and the key with it.
const periodCount = (count) => {
  const n = Number(count);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

export function periodMonths({ unit, count } = {}) {
  const multiplier = periodCount(count);
  if (unit === "months_n") return multiplier;
  return (UNIT_MONTHS[unit] ?? 1) * multiplier;
}

// ── Period keys ───────────────────────────────────────────────────────────────
// The key is the idempotency key for BOTH cb_manual_marks and cb_alerts, so it
// has to be (a) stable — the same period must produce the same string on every
// run, no clock, no locale, no rounding involved — (b) collision-free between
// two periods of the same benefit, and (c) collision-free between two SHAPES of
// the same benefit.
//
// (c) is why every key carries `unit:count` as well as the window. A key built
// from the window alone is ambiguous: year×1, half×2, quarter×4 and month×12 all
// resolve to Jan 1 – Dec 31, and an anniversary key built from the start date
// alone is produced identically by all four. PATCH /api/benefits/benefits/:id can
// change a benefit's period shape, and without the shape in the key the old
// manual marks would be silently adopted by the new window — a credit reported
// spent that never was. There is no production data on this format yet, so it
// encodes the shape from the start.
const shape = (unit, count) => `${String(unit || "month")}:${periodCount(count)}`;

function calendarKey(unit, count, len, start) {
  const prefix = `cal:${shape(unit, count)}`;
  if (unit === "month" && len === 1) return `${prefix}:${String(start.y).padStart(4, "0")}-${String(start.m).padStart(2, "0")}`;
  if (unit === "quarter" && len === 3) return `${prefix}:${start.y}-Q${Math.floor((start.m - 1) / 3) + 1}`;
  if (unit === "half" && len === 6) return `${prefix}:${start.y}-H${start.m <= 6 ? 1 : 2}`;
  if (unit === "year" && len === 12) return `${prefix}:${start.y}`;
  // Any other span (a 2-month or 5-month credit) has no conventional name, so
  // the start date stands in. Still start-derived, so still distinct between
  // adjacent periods.
  return `${prefix}:${iso(start)}`;
}

// ── resolvePeriod ─────────────────────────────────────────────────────────────
// { key, start, end, daysLeft } for the period containing `today`.
// `start`/`end` are inclusive YYYY-MM-DD; `daysLeft` counts from today to end,
// so the last day of a period reads 0.
export function resolvePeriod({ unit, count, basis, anniversaryDate, anchorDate } = {}, today) {
  const now = parts(today);
  if (!now) throw new Error("resolvePeriod requires today as YYYY-MM-DD");
  const len = periodMonths({ unit, count });

  // months_n is anchored to LAST USE, not to any calendar or anniversary line —
  // a Global Entry credit's 48 months start the day it was redeemed — so
  // `basis` does not apply to it.
  if (unit === "months_n") return resolveAnchored(unit, count, len, anchorDate, now);

  if (basis === "anniversary") {
    const base = parts(anniversaryDate);
    // A card with no anniversary on file cannot have anniversary boundaries.
    // Falling back to the calendar is the lesser wrong: it is visibly a
    // calendar period in the response (period_start is Jan 1) rather than a
    // made-up anniversary the owner would have no way to spot.
    if (base) return resolveAnniversary(unit, count, len, base, now);
  }
  return resolveCalendar(unit, count, len, now);
}

// ── recentPeriods ─────────────────────────────────────────────────────────────
// The current period, every preceding period that reaches back into the last
// `lookbackDays`, AND — regardless of length — at least `minPrevious` of them.
// Newest first.
//
// This exists because a posted statement credit lands a cycle AFTER the charge
// it confirms: a read that only ever looks at the current period can never see
// the charge the credit belongs to, and would instead read the credit as fresh
// usage of the NEW period — consuming an allowance nobody has spent and
// suppressing the alert the owner actually needs.
//
// The `minPrevious` floor is the fix for the annual case. A 120-day lookback
// covers 4-5 monthly periods, but a calendar YEAR is already longer than the
// lookback, so a pure days-based rule returned the current year alone: a
// December charge was invisible when its January credit was attributed, and
// that credit became standalone usage of the new year. Tiling one whole period
// back regardless of length makes "the window after period P, where P's credit
// posts" always in scope, because scope periods tile contiguously — that window
// IS the next period. It is also date-independent: month 1 and month 8 of the
// year produce the same two-period scope, so the answer cannot depend on when
// the read happens to run.
//
// The remaining blind spot, stated as the bound: a credit posting more than
// `lookbackDays` AND more than one full period after its charge.
//
// months_n is excluded on purpose: an anchored cycle has exactly one window at
// a time (the one its anchor defines), and "the period before it" is not a
// thing the anchor can express.
const MAX_LOOKBACK_PERIODS = 24;

export function recentPeriods(spec = {}, today, lookbackDays = 0, { minPrevious = 1 } = {}) {
  const current = resolvePeriod(spec, today);
  const periods = [current];
  if (spec.unit === "months_n") return periods;

  const days = Number(lookbackDays);
  const floor = iso(addDays(parts(today), -(Number.isFinite(days) && days > 0 ? Math.floor(days) : 0)));
  const atLeast = Number.isFinite(Number(minPrevious)) && Number(minPrevious) > 0 ? Math.floor(Number(minPrevious)) : 0;
  let cursor = current;
  // The cap is a guard, not a limit: a 120-day lookback is 5 monthly periods.
  // It only exists so a spec that somehow fails to make progress cannot spin.
  for (let i = 0; i < MAX_LOOKBACK_PERIODS; i++) {
    if (!cursor.start) break;
    // The floor wins while it is unmet; after that the lookback decides.
    if (periods.length - 1 >= atLeast && cursor.start <= floor) break;
    const previous = resolvePeriod(spec, iso(addDays(parts(cursor.start), -1)));
    if (!previous.start || previous.key === cursor.key) break;
    periods.push(previous);
    cursor = previous;
  }
  return periods;
}

// Day arithmetic on a YYYY-MM-DD string, for callers outside this module that
// need a date offset without importing a second date library. UTC parts only,
// like everything else here.
export function addDaysIso(value, n) {
  const base = parts(value);
  return base ? iso(addDays(base, n)) : null;
}

// Calendar boundaries by tiling absolute month numbers into `len`-month blocks.
// Because the tiling starts at year 0 / January, len 3 lands on calendar
// quarters, len 6 on Jan–Jun and Jul–Dec, and len 12 on Jan 1 – Dec 31, with no
// special cases and no year-rollover branch: Dec 31 and Jan 1 differ by one
// month index and therefore fall in different blocks by construction.
function resolveCalendar(unit, count, len, now) {
  const block = Math.floor(monthIndex(now) / len);
  const start = monthStart(block * len);
  const nextStart = monthStart((block + 1) * len);
  const end = addDays(nextStart, -1);
  return { key: calendarKey(unit, count, len, start), start: iso(start), end: iso(end), daysLeft: daysBetween(now, end) };
}

// Cardmember-year boundaries: the Venture X travel credit resets on the account
// anniversary, NOT on Jan 1. Getting this wrong reports a spent credit as
// available (or the reverse) for up to a year, which is the worst bug this
// feature can have, so the period is derived from the anniversary date itself
// and only ever by whole `len`-month steps FROM THAT BASE (see addMonths).
//
// The month-index estimate can be off by one in either direction because it
// ignores the day of month, so it is corrected by stepping rather than trusted.
function resolveAnniversary(unit, count, len, base, now) {
  let k = Math.floor((monthIndex(now) - monthIndex(base)) / len);
  let start = addMonths(base, k * len);
  while (isAfter(start, now)) {
    k -= 1;
    start = addMonths(base, k * len);
  }
  let next = addMonths(base, (k + 1) * len);
  while (!isAfter(next, now)) {
    start = next;
    k += 1;
    next = addMonths(base, (k + 1) * len);
  }
  const end = addDays(next, -1);
  return {
    key: `anniv:${shape(unit, count)}:${iso(start)}`,
    start: iso(start), end: iso(end), daysLeft: daysBetween(now, end),
  };
}

// Multi-year cycles anchored to last use. Two states:
//
//   - inside the cycle: [anchor, anchor + len months), keyed by the anchor, so
//     the key stays put for as long as that use is the most recent one.
//   - no anchor, or an anchor whose cycle has already lapsed: the benefit is
//     AVAILABLE and there is no expiry to count down to, hence end/daysLeft
//     null (nothing to nag about — see alertTiers).
//
// `start` in the available case is not a window the benefit is confined to; it
// is the trailing span we would have had to see in order to say "not used in
// the last `len` months" honestly. evaluateBenefits measures history coverage
// against it, so a card linked six months ago reports insufficient-history for
// a 48-month benefit instead of a confident "available".
function resolveAnchored(unit, count, len, anchorDate, now) {
  const prefix = `anchor:${shape(unit, count)}`;
  const anchor = parts(anchorDate);
  if (anchor) {
    const next = addMonths(anchor, len);
    const end = addDays(next, -1);
    if (!isAfter(now, end)) {
      return { key: `${prefix}:${iso(anchor)}`, start: iso(anchor), end: iso(end), daysLeft: daysBetween(now, end) };
    }
    // Lapsed — fall through to the available shape below.
  }
  // +1 day so a use exactly `len` months ago (whose cycle ended yesterday)
  // falls outside the trailing window rather than on its edge.
  const trailingStart = addDays(addMonths(now, -len), 1);
  return { key: `${prefix}:none`, start: iso(trailingStart), end: null, daysLeft: null };
}

// ── Evaluation ────────────────────────────────────────────────────────────────

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// `rule-error` is here for the same reason `used` is — chasing the owner about
// a benefit they cannot act on trains the mailbox to ignore this sender — but
// alertTiers gives it its own tier instead of pure silence, because a benefit
// whose rule no longer runs is worth exactly one message per period.
const NEVER_ALERT = new Set(["used", "used-unconfirmed", "insufficient-history", "rule-error"]);

// cards → the `cards` array of GET /api/benefits/status.
//
// NOTHING here is read from a stored usage table any more (Brief 05,
// derive-on-read): benefits/derive.js turns the transaction rows and the match
// rules into per-benefit statistics for the CURRENT period, and this function
// turns those statistics into the contract's status/confidence enums. The two
// halves are split so the arithmetic that decides "is this credit spent" stays
// unit-testable without a database, exactly as before.
//
//   cards            catalog rows, each with a `benefits` array, each benefit
//                    with its `rules` array (rule COUNT is what matters here —
//                    matching itself already happened and produced `stats`)
//   stats            { [benefit_id]: <derive.js benefit stats> }; see
//                    deriveBenefitStats for the shape. A benefit with no entry
//                    is evaluated as having no usage.
//   historyByAccount { [plaid account_id]: earliest transaction date }
//   ruleErrors       { benefit_id, rule_id, message } for every match rule that
//                    FAILED to compile for this read (an owner-entered regex
//                    that no longer parses, typically). A benefit with one of
//                    these has an unknown amount of usage, not zero.
export function evaluateBenefits({ cards = [], stats = {}, historyByAccount = {}, ruleErrors = [] } = {}, today) {
  const asOf = toDateString(today);
  if (!asOf) throw new Error("evaluateBenefits requires today as YYYY-MM-DD");

  // First error per benefit: one broken rule is enough to make the whole
  // benefit unevaluatable, and naming one rule the owner can go fix beats a
  // list they have to read.
  const errorByBenefit = new Map();
  for (const err of ruleErrors) {
    const key = String(err.benefit_id);
    if (!errorByBenefit.has(key)) errorByBenefit.set(key, err);
  }

  const statsFor = (id) =>
    (stats instanceof Map ? stats.get(String(id)) : stats?.[String(id)]) || null;

  return cards.map((card) => {
    const historyStart = toDateString(card.account_id ? historyByAccount[card.account_id] : null);
    return {
      id: card.id,
      nickname: card.nickname,
      issuer: card.issuer ?? null,
      product: card.product ?? null,
      account_id: card.account_id ?? null,
      anniversary_date: toDateString(card.anniversary_date),
      annual_fee: numOrNull(card.annual_fee),
      history_start: historyStart,
      benefits: (card.benefits || []).map((benefit) =>
        evaluateBenefit(
          benefit, card, statsFor(benefit.id), historyStart, asOf,
          errorByBenefit.get(String(benefit.id)) || null
        )
      ),
    };
  });
}

function evaluateBenefit(benefit, card, stat, historyStart, today, ruleError) {
  const unit = benefit.period_unit;
  const count = Number(benefit.period_count) || 1;
  const basis = benefit.period_basis || "calendar";

  // derive.js already resolved this benefit's window (it had to, to build the
  // scan windows and to pick the anchor of a months_n cycle out of the matched
  // rows). Resolving it again here would be a second answer to a question that
  // must only have one, so the derived period is used when it is there and
  // recomputed only for a benefit derive never saw.
  const period = stat?.period || resolvePeriod(
    { unit, count, basis, anniversaryDate: card.anniversary_date, anchorDate: null },
    today
  );

  const limit = num(benefit.amount_limit);
  const oneShot = limit <= 0; // lounge access, elite status: used or not, no dollars

  // A manual mark is the owner telling us what they did with this period, and
  // it OUTRANKS whatever matching inferred: a mark of the full $100 plus a
  // matched $100 charge is one $100 use seen twice, not $200 of spend. Since
  // the mark now lives in its own table (cb_manual_marks) rather than sharing
  // cb_usage with the automatic rows, "outranks" is a branch here and nothing
  // can clobber anything. The automatic matches are still listed in `matches`
  // — they are the evidence the mark is checked against.
  const mark = stat?.manual || null;

  // Charges and the credits that confirm them are two halves of ONE spend, so
  // they are never summed. A charge always carries its full amount; a credit
  // paired to it contributes only to confirmedTotal; only the residue of a
  // credit with no charge to confirm is money of its own. derive.js does that
  // arithmetic — see the pairing notes there.
  const amountUsed = mark ? round2(Math.abs(num(mark.amount))) : round2(num(stat?.amountUsed));
  const confirmedTotal = round2(num(stat?.confirmedTotal));

  const ruleCount = Array.isArray(benefit.rules) ? benefit.rules.length : Number(benefit.rule_count) || 0;

  // A benefit that matched a transaction whose money belongs to an EARLIER
  // period (the January credit for a December charge) has evidence in this
  // period and no usage of it. Usage is therefore measured in dollars, never in
  // rows: counting rows is what turned that credit into a spent allowance.
  const used = Boolean(mark) || amountUsed > 0;

  let status;
  let confidence;
  if (!used) {
    confidence = "none";
    // Order matters. manual-only comes before the history check because a
    // benefit with no match rules has no transaction footprint at all — how far
    // back the card's transactions go says nothing about it. Everything else
    // must clear history coverage before it is allowed to claim `available`:
    // no history for the account, or a period that opened before coverage did,
    // means we cannot see the window and must say so.
    if (ruleCount === 0) status = "manual-only";
    else if (!historyStart || (period.start && period.start < historyStart)) status = "insufficient-history";
    else status = "available";
  } else {
    // 0.005 rather than exact equality: amounts are NUMERIC(12,2) round-tripped
    // through floats, and a credit short by half a cent is not "partially used".
    const fullyUsed = oneShot || amountUsed + 0.005 >= limit;
    // `confirmed` now means EVERY counted dollar has a posted credit behind it,
    // not merely that some credit exists in the period (05-api-contract.md
    // records the change). Three $100 charges settled by one $100 credit are
    // $300 used with $100 confirmed, and reporting that as `confirmed` would be
    // a claim the statement does not support.
    confidence = mark ? "manual" : confirmedTotal + 0.005 >= amountUsed ? "confirmed" : "unconfirmed";
    // A charge-only match is optimistic — the qualifying charge posted, the
    // statement credit has not — so it reports used-unconfirmed and is never
    // alerted on. An owner's manual mark needs no confirmation.
    if (fullyUsed) status = confidence === "manual" || confidence === "confirmed" ? "used" : "used-unconfirmed";
    else status = "partially-used";
  }

  // A match rule that could not RUN, or one matching more transactions than the
  // pairing pass can hold, leaves a hole in the evidence — so every figure above
  // is a floor rather than a total, and the one thing this feature may never do
  // is let that hole read as `available`. A benefit whose regex stopped parsing
  // would otherwise report an unused credit forever, in green, with no
  // indication that nothing was ever evaluated.
  let ruleErrorText = null;
  if (ruleError) ruleErrorText = `rule ${ruleError.rule_id}: ${ruleError.message}`;
  else if (stat?.overflow) ruleErrorText = stat.overflow;
  if (ruleErrorText) status = "rule-error";

  return {
    id: benefit.id,
    name: benefit.name,
    amount_limit: numOrNull(benefit.amount_limit),
    period: { unit, count, basis },
    // Captured for a later phase and returned as stored: NOTHING below applies
    // it. An unused amount does not roll into the next period — every period's
    // allowance is `amount_limit`, whatever the previous period left on the
    // table. The catalog editor labels the control as not yet applied so the
    // checkbox cannot quietly imply arithmetic that does not happen.
    carryover: Boolean(benefit.carryover),
    verified_on: toDateString(benefit.verified_on),
    notes: benefit.notes ?? null,
    period_key: period.key,
    period_start: period.start,
    period_end: period.end,
    days_left: period.daysLeft,
    amount_used: amountUsed,
    amount_remaining: round2(Math.max(0, limit - amountUsed)),
    status,
    confidence,
    // Which rule broke, so the owner can go fix that one rather than hunt.
    rule_error: ruleErrorText,
    // `matches` is a bounded sample; saying so is mandatory here for the same
    // reason it is in limits.js — a capped list that looks complete is worse
    // than a short one. `amount_used` never comes from this list: it is summed
    // in SQL over the whole period (see derive.js / fetchUsageAggregates).
    matches_truncated: Boolean(stat?.matchesTruncated),
    matches: [
      ...(stat?.matches || []).map((m) => ({
        txn_id: m.txn_id ?? null,
        date: toDateString(m.date),
        merchant: m.merchant ?? null,
        amount: round2(Math.abs(num(m.amount))),
        source: "auto",
      })),
      // The owner's own mark, listed alongside the automatic evidence so a
      // benefit that lives entirely on this path (lounge access, elite status)
      // still shows what was recorded and when.
      ...(mark ? [{
        txn_id: null,
        date: toDateString(mark.date ?? mark.created_at ?? null),
        merchant: null,
        amount: round2(Math.abs(num(mark.amount))),
        source: "manual",
      }] : []),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };
}

// ── Alert tiers ───────────────────────────────────────────────────────────────
// Which nudges are DUE for a benefit today. Whether one has already been sent
// is cb_alerts' business (benefit_id, period_key, tier) — this only decides
// what would be worth saying.
//
// Thresholds follow the brief: a monthly credit ~7 days before the period ends,
// quarterly/semiannual ~21, annual (and any longer cycle) at ~45 and again at
// ~14. Plus `period-opened` on the day a period resets, which is the one
// positive notification here.
//
// Never on `used` or `used-unconfirmed` — chasing a credit that is already
// spent, or already charged and merely waiting on the statement, trains the
// mailbox to ignore this sender — and never on `insufficient-history`, because
// alerting on a window we cannot see is exactly the confidently-wrong nudge the
// status exists to prevent. `rule-error` gets no expiry nudge either, for the
// same reason: the figure one would quote was never computed. It gets a tier of
// its own instead, because a benefit nobody can evaluate is worth saying once.
export function alertTiers({ benefit, daysLeft, status } = {}) {
  // The one exception to the never-alert set: a benefit whose match rule no
  // longer runs cannot be evaluated at all, and silence about it is how a
  // broken regex goes unnoticed for a year. One tier, so cb_alerts caps it at
  // one message per period rather than one per day.
  if (status === "rule-error") return ["rule-error"];
  if (NEVER_ALERT.has(status)) return [];
  const tiers = [];
  // An explicit finite-number check, not a null guard: Number(null), Number(""),
  // Number(false) and Number([]) are all 0, and a benefit with no expiry that
  // read as "expires today" would fire every tier it has.
  const days = Number.isFinite(daysLeft) ? daysLeft : NaN;
  const start = parts(benefit?.period_start);
  const end = parts(benefit?.period_end);

  // "The period opened today" without needing today: on the first day of a
  // period, the days remaining equal the whole span from start to end.
  if (start && end && Number.isFinite(days) && daysBetween(start, end) === days) tiers.push("period-opened");

  // No end date means nothing expires (an anchored cycle that is available
  // again). There is nothing to count down to, so there is nothing to send.
  if (!Number.isFinite(days) || days < 0) return tiers;

  const len = periodMonths({
    unit: benefit?.period?.unit ?? benefit?.period_unit,
    count: benefit?.period?.count ?? benefit?.period_count,
  });
  const thresholds = len <= 1 ? [7] : len <= 6 ? [21] : [14, 45];

  // Ascending, so the most urgent tier a caller has not sent yet comes first.
  for (const t of thresholds) if (days <= t) tiers.push(`expiring-${t}d`);
  return tiers;
}
