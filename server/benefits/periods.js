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

export function periodMonths({ unit, count } = {}) {
  const n = Number(count);
  const multiplier = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  if (unit === "months_n") return multiplier;
  return (UNIT_MONTHS[unit] ?? 1) * multiplier;
}

// ── Period keys ───────────────────────────────────────────────────────────────
// The key is the idempotency key for BOTH cb_usage and cb_alerts, so it has to
// be (a) stable — the same period must produce the same string on every run, no
// clock, no locale, no rounding involved — and (b) collision-free between two
// periods of the same benefit. Every form below is derived from the period's
// start date, which satisfies both by construction.
function calendarKey(unit, len, start) {
  if (unit === "month" && len === 1) return `${String(start.y).padStart(4, "0")}-${String(start.m).padStart(2, "0")}`;
  if (unit === "quarter" && len === 3) return `${start.y}-Q${Math.floor((start.m - 1) / 3) + 1}`;
  if (unit === "half" && len === 6) return `${start.y}-H${start.m <= 6 ? 1 : 2}`;
  if (unit === "year" && len === 12) return String(start.y);
  // Any other span (a 2-month or 5-month credit) has no conventional name, so
  // the start date stands in. Still start-derived, so still distinct between
  // adjacent periods.
  return `cal:${iso(start)}`;
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
  if (unit === "months_n") return resolveAnchored(len, anchorDate, now);

  if (basis === "anniversary") {
    const base = parts(anniversaryDate);
    // A card with no anniversary on file cannot have anniversary boundaries.
    // Falling back to the calendar is the lesser wrong: it is visibly a
    // calendar period in the response (period_start is Jan 1) rather than a
    // made-up anniversary the owner would have no way to spot.
    if (base) return resolveAnniversary(len, base, now);
  }
  return resolveCalendar(unit, len, now);
}

// Calendar boundaries by tiling absolute month numbers into `len`-month blocks.
// Because the tiling starts at year 0 / January, len 3 lands on calendar
// quarters, len 6 on Jan–Jun and Jul–Dec, and len 12 on Jan 1 – Dec 31, with no
// special cases and no year-rollover branch: Dec 31 and Jan 1 differ by one
// month index and therefore fall in different blocks by construction.
function resolveCalendar(unit, len, now) {
  const block = Math.floor(monthIndex(now) / len);
  const start = monthStart(block * len);
  const nextStart = monthStart((block + 1) * len);
  const end = addDays(nextStart, -1);
  return { key: calendarKey(unit, len, start), start: iso(start), end: iso(end), daysLeft: daysBetween(now, end) };
}

// Cardmember-year boundaries: the Venture X travel credit resets on the account
// anniversary, NOT on Jan 1. Getting this wrong reports a spent credit as
// available (or the reverse) for up to a year, which is the worst bug this
// feature can have, so the period is derived from the anniversary date itself
// and only ever by whole `len`-month steps FROM THAT BASE (see addMonths).
//
// The month-index estimate can be off by one in either direction because it
// ignores the day of month, so it is corrected by stepping rather than trusted.
function resolveAnniversary(len, base, now) {
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
  return { key: `anniv:${iso(start)}`, start: iso(start), end: iso(end), daysLeft: daysBetween(now, end) };
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
function resolveAnchored(len, anchorDate, now) {
  const anchor = parts(anchorDate);
  if (anchor) {
    const next = addMonths(anchor, len);
    const end = addDays(next, -1);
    if (!isAfter(now, end)) {
      return { key: `anchor:${iso(anchor)}`, start: iso(anchor), end: iso(end), daysLeft: daysBetween(now, end) };
    }
    // Lapsed — fall through to the available shape below.
  }
  // +1 day so a use exactly `len` months ago (whose cycle ended yesterday)
  // falls outside the trailing window rather than on its edge.
  const trailingStart = addDays(addMonths(now, -len), 1);
  return { key: "anchor:none", start: iso(trailingStart), end: null, daysLeft: null };
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

// A usage row's own date: the matched transaction's date for automatic rows,
// the row's creation date for a manual mark.
const rowDate = (r) => toDateString(r.date ?? r.created_at ?? null);

// A row is CONFIRMING when it came from a posted statement credit rather than
// from the qualifying charge. Two spellings are accepted because both ends of
// the pipeline are legitimate sources of the fact: repository.js stamps
// confirmed_at on credit-direction matches at insert time, and a caller
// evaluating rows it just matched in memory carries the rule's `direction`.
const isConfirming = (r) => Boolean(r.confirmed_at) || r.direction === "credit";

const NEVER_ALERT = new Set(["used", "used-unconfirmed", "insufficient-history"]);

// cards → the `cards` array of GET /api/benefits/status.
//
//   cards            catalog rows, each with a `benefits` array, each benefit
//                    with its `rules` array (rule COUNT is what matters here —
//                    matching itself already happened and produced usageRows)
//   usageRows        cb_usage rows, joined to their transaction for date and
//                    merchant
//   historyByAccount { [plaid account_id]: earliest transaction date }
export function evaluateBenefits({ cards = [], usageRows = [], historyByAccount = {} } = {}, today) {
  const asOf = toDateString(today);
  if (!asOf) throw new Error("evaluateBenefits requires today as YYYY-MM-DD");

  const byBenefit = new Map();
  for (const row of usageRows) {
    const key = String(row.benefit_id);
    if (!byBenefit.has(key)) byBenefit.set(key, []);
    byBenefit.get(key).push(row);
  }

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
        evaluateBenefit(benefit, card, byBenefit.get(String(benefit.id)) || [], historyStart, asOf)
      ),
    };
  });
}

function evaluateBenefit(benefit, card, rows, historyStart, today) {
  const unit = benefit.period_unit;
  const count = Number(benefit.period_count) || 1;
  const basis = benefit.period_basis || "calendar";

  // For an anchored cycle the anchor IS the most recent recorded use, so it has
  // to be derived before the period can be resolved.
  const anchorDate = unit === "months_n"
    ? rows.map(rowDate).filter(Boolean).sort().pop() || null
    : null;

  const period = resolvePeriod(
    { unit, count, basis, anniversaryDate: card.anniversary_date, anchorDate },
    today
  );

  // Anchored cycles select by DATE, not by key: a use recorded under the
  // "anchor:none" key becomes the anchor of the very next evaluation, at which
  // point the key changes and a key-equality filter would lose the row that
  // defined the period. Every other shape has a fixed key and uses it.
  const inPeriod = unit === "months_n"
    ? rows.filter((r) => {
        const d = rowDate(r);
        if (!d || !period.start) return false;
        return d >= period.start && (!period.end || d <= period.end);
      })
    : rows.filter((r) => r.period_key === period.key);

  const limit = num(benefit.amount_limit);
  const oneShot = limit <= 0; // lounge access, elite status: used or not, no dollars

  // Charges and posted credits are two halves of the SAME spend, a cycle apart.
  // Summing both would double-count, so the charge side is authoritative for
  // the amount when it exists and the credit side only confirms it; a benefit
  // matched solely on its posted credit still gets an amount from that credit.
  const confirming = inPeriod.filter(isConfirming);
  const charged = inPeriod.filter((r) => !isConfirming(r));
  const counted = charged.length ? charged : confirming;
  const amountUsed = round2(counted.reduce((sum, r) => sum + Math.abs(num(r.amount)), 0));

  const ruleCount = Array.isArray(benefit.rules) ? benefit.rules.length : Number(benefit.rule_count) || 0;
  const allManual = inPeriod.length > 0 && inPeriod.every((r) => r.source === "manual");
  // 0.005 rather than exact equality: amounts are NUMERIC(12,2) round-tripped
  // through floats, and a credit short by half a cent is not "partially used".
  const fullyUsed = inPeriod.length > 0 && (oneShot || amountUsed + 0.005 >= limit);

  let status;
  let confidence;
  if (inPeriod.length === 0) {
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
    confidence = confirming.length ? "confirmed" : allManual ? "manual" : "unconfirmed";
    // A charge-only match is optimistic — the qualifying charge posted, the
    // statement credit has not — so it reports used-unconfirmed and is never
    // alerted on. An owner's manual mark needs no confirmation.
    if (fullyUsed) status = confirming.length || allManual ? "used" : "used-unconfirmed";
    else status = "partially-used";
  }

  return {
    id: benefit.id,
    name: benefit.name,
    amount_limit: numOrNull(benefit.amount_limit),
    period: { unit, count, basis },
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
    matches: inPeriod
      .map((r) => ({
        txn_id: r.txn_id ?? null,
        date: rowDate(r),
        merchant: r.merchant ?? null,
        amount: round2(Math.abs(num(r.amount))),
        source: r.source || "auto",
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date))),
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
// status exists to prevent.
export function alertTiers({ benefit, daysLeft, status } = {}) {
  if (NEVER_ALERT.has(status)) return [];
  const tiers = [];
  // Number(null) is 0, not NaN — a benefit with no expiry would otherwise read
  // as "expires today" and fire every tier it has.
  const days = daysLeft === null || daysLeft === undefined || daysLeft === "" ? NaN : Number(daysLeft);
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
