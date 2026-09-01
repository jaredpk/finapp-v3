// Pure display helpers shared by the Benefits view, the catalog editor and the
// match-rule tester — same split as components/property/propertyFinanceUtils.js:
// formatting and status metadata only, no data access.

export const fmt = (n) =>
  n == null ? "—" : "$" + Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Units ─────────────────────────────────────────────────────────────────────
// A benefit's amount_limit / amount_used / amount_remaining are denominated in
// its `unit`, not always in dollars: a Sky Club allowance is counted in visits
// and a transfer bonus in points. Rendering either with `fmt` produces a
// sentence that is simply false ("$3.00 left" for three lounge visits), so
// every benefit-denominated amount goes through fmtUnit / fmtUsedOf instead.
//
// A raw TRANSACTION amount stays on `fmt`: those really are dollars, whatever
// the benefit they matched is counted in.
//
// Anything unrecognised falls back to dollars, which is what every benefit
// meant before this column existed.
const UNITS = new Set(["usd", "points", "visits", "count"]);
export const benefitUnit = (u) => (UNITS.has(u) ? u : "usd");

const whole = (n) => Math.abs(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const upTo2 = (n) => Math.abs(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

// One amount on its own: "$1,234.56", "10,000 pts", "3 visits", "3".
export function fmtUnit(n, unit) {
  if (n == null) return "—";
  const u = benefitUnit(unit);
  if (u === "usd") return fmt(n);
  if (u === "points") return `${upTo2(n)} pts`;
  if (u === "visits") return `${whole(n)} visit${Math.round(Math.abs(Number(n) || 0)) === 1 ? "" : "s"}`;
  return whole(n);
}

// Used against the allowance: "$4.12 of $15.00", "10,000 of 25,000 pts",
// "3 of 10 visits", "3 of 5". The unit is named once, at the end, rather than
// on both halves.
export function fmtUsedOf(used, limit, unit) {
  const u = benefitUnit(unit);
  if (u === "usd") return `${fmt(used)} of ${fmt(limit)}`;
  if (u === "points") return `${upTo2(used)} of ${upTo2(limit)} pts`;
  if (u === "visits") return `${whole(used)} of ${whole(limit)} visits`;
  return `${whole(used)} of ${whole(limit)}`;
}

// The label the mark-used form puts on its amount box, so it never implies
// dollars for a benefit counted in something else.
export const UNIT_FIELD_LABEL = {
  usd: "Amount ($)",
  points: "Points",
  visits: "Visits",
  count: "Uses",
};
export const unitFieldLabel = (unit) => UNIT_FIELD_LABEL[benefitUnit(unit)];

export const BENEFIT_UNITS = [
  { value: "usd", label: "Dollars ($)" },
  { value: "points", label: "Points / miles" },
  { value: "visits", label: "Visits" },
  { value: "count", label: "Uses (count)" },
];

// Each entry names the MEASUREMENT rule, not just the display, because that is
// the part that surprises people: switching a benefit to visits changes what
// amount_used counts, and points cannot be counted automatically at all.
export const UNIT_HELP = {
  usd: "Dollars — usage is the SUM of the matched transaction amounts. This is how every benefit worked before units existed.",
  points: "Points / miles — usage CANNOT be derived from transactions: a transaction amount is in dollars, and adding dollars into a points allowance is meaningless. Matched transactions are still listed as evidence, but a points benefit is manual-only until you mark it used.",
  visits: "Visits — usage is the COUNT of matching transactions, one visit each, not the sum of their amounts. Three matching charges against a 10-visit allowance read 3 of 10.",
  count: "Uses — usage is the COUNT of matching transactions, one use each, not the sum of their amounts.",
};

export const CYCLE_ANCHOR_HELP =
  "Optional. Overrides the card's anniversary date for THIS benefit when the period basis is Anniversary — the date the benefit's own cycle starts. Use it for a credit that renews on its own date (a Venture X credit that renews December 17: enter any December 17) or for a cycle that runs February through January (enter any February 1). Leave it empty to follow the card's anniversary. Changing it moves the benefit into a different period key, so alerts already sent for the old window can fire once more under the new one.";

// Benefit dates arrive as YYYY-MM-DD, so they are read as UTC like the property
// components do — parsing them locally shifts a period boundary by a day.
export const fmtDay = (d) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";

export const todayIso = () => new Date().toISOString().slice(0, 10);

// One entry per value of `status` in the API contract. `insufficient-history`
// deliberately gets a muted, hatched, dashed treatment and a caption rather
// than anything that reads as a green "go spend it" affordance: the server
// returns it when the period starts before the card's history begins, so the
// honest statement is "we cannot see this window", not "unused".
// `used-unconfirmed` is amber and dashed so a charge that matched but whose
// statement credit has not posted never reads as settled. `rule-error` is the
// same principle turned up: a benefit whose match rule stopped running has an
// unknown amount of usage, so it renders as a fault to go fix — red, hatched,
// never green and never "available".
//
// `amountCaption` replaces the "$x of $y used" line for the two states where
// that sentence would be a claim we cannot make.
export const STATUS_META = {
  "available": {
    label: "Available",
    color: "var(--green, #22c55e)",
    glyph: "○",
    note: "Nothing has matched this period yet.",
  },
  "partially-used": {
    label: "Partly used",
    color: "var(--blue, #3c6ff0)",
    glyph: "◐",
    note: "Some of this credit has been spent this period.",
  },
  "used-unconfirmed": {
    label: "Used · unconfirmed",
    color: "var(--amber, #f59e0b)",
    glyph: "◍",
    dashed: true,
    note: "A qualifying charge matched, but the statement credit has not posted yet.",
    alwaysShowNote: true,
  },
  "used": {
    label: "Used",
    color: "var(--text)",
    glyph: "✓",
    note: "The statement credit has posted for this period.",
  },
  "insufficient-history": {
    label: "History too short",
    color: "var(--muted)",
    glyph: "◌",
    dashed: true,
    hatched: true,
    amountCaption: "window not covered",
    note: "Transaction history for this card does not reach back to the start of this period, so we cannot tell whether the credit was used. Not the same as unused.",
    alwaysShowNote: true,
  },
  "rule-error": {
    label: "Rule error",
    color: "var(--red)",
    glyph: "!",
    dashed: true,
    hatched: true,
    amountCaption: "usage not evaluated",
    note: "A match rule for this benefit could not run, so nothing was evaluated this period. Whatever is shown is a floor, not a total — fix the rule in the Catalog tab.",
    alwaysShowNote: true,
  },
  "manual-only": {
    label: "Manual only",
    color: "var(--accent)",
    glyph: "✎",
    note: "This benefit leaves no transaction behind, or is counted in points — mark it used by hand.",
  },
  // The third member of the same family: a window we cannot resolve at all. The
  // benefit resets on an anniversary and neither it nor its card carries a date
  // to count from, so the server falls back to a calendar window just to have a
  // key — and every figure below was measured inside a window this app invented.
  // Hatched and amber, never green, and the note names the missing field rather
  // than leaving the owner to guess which one it wants.
  "no-anchor": {
    label: "No cycle anchor",
    color: "var(--amber, #f59e0b)",
    glyph: "◇",
    dashed: true,
    hatched: true,
    amountCaption: "period not resolved",
    note: "This benefit resets on an anniversary, but neither its own cycle anchor nor the card's anniversary date is set — there is no date to count the cycle from, so the window shown is a calendar fallback and nothing here was evaluated against the real period. Set Cycle anchor on the benefit, or Anniversary date on the card, in the Catalog tab.",
    alwaysShowNote: true,
  },
};

// A status this build does not know about must not fall through to the
// "available" styling; it renders as unknown instead.
export const UNKNOWN_STATUS = {
  label: "Unknown",
  color: "var(--muted)",
  glyph: "?",
  dashed: true,
  hatched: true,
  note: "The server reported a status this page does not recognise.",
  alwaysShowNote: true,
};

export const statusMeta = (status) => STATUS_META[status] || { ...UNKNOWN_STATUS, label: status || "Unknown" };

// Enum values are fixed by the API contract; only the labels are ours.
export const PERIOD_UNITS = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "half", label: "Half-year" },
  { value: "year", label: "Year" },
  { value: "months_n", label: "N months (custom cycle)" },
];

export const PERIOD_BASES = [
  { value: "calendar", label: "Calendar" },
  { value: "anniversary", label: "Anniversary" },
];

export const BASIS_HELP = {
  calendar: "Calendar basis — the credit resets on the calendar boundary (Jan 1 for an annual credit, the 1st for a monthly one).",
  anniversary: "Anniversary basis — the credit resets on the card's account anniversary, not on Jan 1.",
};

export const RULE_DIRECTIONS = [
  { value: "charge", label: "Qualifying charge" },
  { value: "credit", label: "Posted statement credit" },
];

const UNIT_LABELS = { month: "Monthly", quarter: "Quarterly", half: "Semiannual", year: "Annual" };

export function periodLabel(period) {
  if (!period) return "—";
  const count = Number(period.count) || 1;
  if (period.unit === "months_n") return `Every ${count} month${count === 1 ? "" : "s"}`;
  if (count > 1) return `Every ${count} ${period.unit}s`;
  return UNIT_LABELS[period.unit] || period.unit || "—";
}

// A catalog nobody has re-checked since the issuer reworked the lineup is the
// thing that makes every number downstream untrustworthy, so "never verified"
// counts as stale too rather than as missing metadata.
export const STALE_AFTER_DAYS = 365;

export function verification(verifiedOn) {
  if (!verifiedOn) return { days: null, stale: true, label: "Never verified" };
  const then = new Date(verifiedOn);
  if (Number.isNaN(then.getTime())) return { days: null, stale: true, label: "Never verified" };
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  return { days, stale: days > STALE_AFTER_DAYS, label: `Verified ${fmtDay(verifiedOn)}` };
}

// The server half of this feature ships separately, so a 404 has to read as
// "not deployed yet" rather than as an empty panel or a silent failure.
export function apiErrorMessage(err, subject = "Benefits") {
  if (err?.status === 404) {
    return `${subject} is not available on this server yet — the benefits API has not shipped. Nothing is wrong with your data.`;
  }
  if (err?.status === 401 || err?.status === 403) {
    return `${subject} was refused — reload the page to sign in again.`;
  }
  return err?.message || `${subject} failed.`;
}
