// Insurance program derivation (Brief 06, phase 1).
//
// This module IMPORTS NOTHING. No pg, no express, no clock of its own — not
// even periods.js, which is why the handful of date helpers below are restated
// here rather than shared. That is deliberate: everything above the extraction
// layer is derived on read, and the arithmetic most likely to be wrong (what a
// six-month premium costs per year, which policy replaced which, when the next
// renewal lands, which endorsement quietly disappeared) has to be unit-testable
// with nothing running (test/insuranceDerive.test.js). Every function takes its
// inputs and, where it needs one, `today`, as arguments.
//
// The brief's line: "Everything above the extraction is derived on read, and
// must be pure." Nothing in this file may be persisted, and nothing in it may
// read a database.

// -- Date parts (UTC only) ----------------------------------------------------
// Same rule as benefits/periods.js: all date arithmetic runs on UTC date PARTS,
// never on a local `new Date("2026-10-12")` plus milliseconds. Local parsing
// shifts by the machine's offset and drifts a whole day across a DST boundary,
// which on a renewal countdown silently moves the reminder by a day — and the
// 14-day tier exists precisely because a day matters there.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

// Accepts what pg hands back for a DATE column (a Date object unless the query
// TO_CHARs it) as well as an already-formatted string, and returns YYYY-MM-DD
// or null. Date -> ISO goes through toISOString(), which is UTC by definition.
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

const utcMs = ({ y, m, d }) => Date.UTC(y, m - 1, d);
const daysBetween = (a, b) => Math.round((utcMs(b) - utcMs(a)) / 86400000);

// The TIMESTAMPTZ counterpart to toDateString, and it exists for the same
// reason: pg hands back a Date object, and String(that) is
// "Tue Sep 01 2026 00:00:00 GMT+0000" — WEEKDAY FIRST. Two of those compared as
// strings sort by the name of the day, so "Tue" beats "Sat" and the older
// document wins the cross-document tie-break in mergeExtractions, which is the
// exact inversion of the rule that function documents. Every shape that
// actually reaches us is normalised to one comparable instant instead: a Date,
// an ISO string, and the "2026-09-05 00:00:00+00" a driver in string mode
// returns. Parsed on UTC parts rather than through Date.parse, which is the
// same rule the date helpers above follow and is why the offset is applied by
// hand. Anything unrecognisable is null, and mergeExtractions sorts those last.
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

export function toInstant(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const m = TIMESTAMP_RE.exec(String(value).trim());
  if (!m) {
    // A bare date (a DATE column, or an ISO string cut to ten characters) still
    // orders correctly against a full timestamp: midnight UTC of that day.
    const day = parts(value);
    return day ? utcMs(day) : null;
  }
  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? 0),
    Number(String(m[7] ?? "").slice(0, 3).padEnd(3, "0"))
  );
  const zone = m[8];
  // No zone at all is read as UTC. That can be off by the server's offset for a
  // TIMESTAMP WITHOUT TIME ZONE, but it is off by the SAME amount for every row
  // compared, and this value is only ever used to order rows against each other.
  if (!zone || zone === "Z" || zone === "z") return ms;
  const digits = zone.slice(1).replace(":", "");
  const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0)) * 60000;
  return zone[0] === "-" ? ms + offset : ms - offset;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Money as carriers print it. A declarations page says "$1,234.00" and a
// coverage screen says "1234", and Number("$1,234.00") is NaN — which would
// report a premium the document states in full as unknown, the one answer this
// module is not allowed to give when the page actually says it. Only the
// currency symbol, thousands separators and surrounding space are stripped;
// anything still unparseable stays unknown rather than being guessed at.
//
// A STRING WITH NO DIGIT IN IT IS UNKNOWN, and that check is the whole reason
// this is not a bare Number() call: Number(""), Number(" "), Number("$") and
// Number([]) are all 0 and all pass a finite check, so a blank premium cell —
// which is reachable both from an extraction that read nothing and from an
// owner override of "" — would annualize to a confident $0.00 a year. Zero is a
// legitimate premium (a fully credited endorsement prints one), so it cannot be
// filtered downstream the way term_months is by its `months <= 0` guard: a
// counted unknown and a stated zero have to be told apart here or not at all.
function money(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (!/\d/.test(s)) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// -- The extraction payload contract ------------------------------------------
// What derive.js expects to find in ins_extractions.payload. Versioned by
// ins_extractions.prompt_version, which is why the version is a column and not
// a guess: an old row keeps meaning what it meant when it was written, because
// a finding may cite it.
//
// Every SCALAR field is a CELL, never a bare value:
//
//     { value: <scalar|null>, state: "value" | "not_stated_in_document" | "unreadable", page: <int|null> }
//
// The three states are the entire point (brief, "Absent != null"). The
// Progressive coverage screens state no policy term at all, and rendering that
// as a blank instead of "go confirm this" is the failure mode the workbook's own
// Open Items r16 was written about. `unreadable` is separate from
// `not_stated_in_document` because they call for different actions: one needs a
// better scan, the other needs a phone call to the carrier.
//
// @typedef {{ value: any, state: "value"|"not_stated_in_document"|"unreadable", page: number|null }} Cell
//
// @typedef {{
//   document_kind: "declarations"|"policy_packet"|"application"|"coverage_screen"
//                 |"quote"|"correspondence"|"unusable",
//   unusable_reason: string|null,   // required when document_kind is "unusable"
//   carrier: Cell, policy_number: Cell, named_insured: Cell,
//   risk_address: Cell,             // the insured PREMISES ...
//   mailing_address: Cell,          // ... which is NOT where the mail goes. Page 1 of the
//                                   // USAA Florida packet shows a Utah mailing address and
//                                   // page 6 shows the Florida risk; collapsing the two files
//                                   // the Florida policy under the Utah house.
//   term_start: Cell, term_end: Cell,
//   term_months: Cell,              // as stated. Never inferred from the dates, and never
//                                   // defaulted to 12 - see annualizePremium.
//   term_premium: Cell,             // as printed, for the term as printed.
//   coverages:      Array<{ code, label, limit_text, limit_value, deductible_text,
//                           deductible_value, premium, page }>,
//   deductibles:    Array<{ peril, text, value, basis: "flat"|"percent", page }>,
//   forms_schedule: Array<{ code, edition, title, disposition: "remains"|"added"|"removed", page }>,
//   credits:        Array<{ label, amount, page }>
// }} ExtractionPayload
export const EXTRACTION_PROMPT_VERSION = 1;

export const CELL_STATES = ["value", "not_stated_in_document", "unreadable"];

// The state reported for a cell that is not in the payload at all. Distinct
// from the three real states: "the model did not answer this question" is not
// the same claim as "the model read the page and the answer was not there".
export const CELL_MISSING = "missing";

// The list sections of the payload, normalized to [] when absent so no caller
// has to guard before iterating.
const LIST_SECTIONS = ["coverages", "deductibles", "forms_schedule", "credits"];

// -- Cells --------------------------------------------------------------------

const isCell = (cell) => typeof cell === "object" && cell !== null && !Array.isArray(cell);

// The state of a cell, or CELL_MISSING when the cell is absent entirely.
export function cellState(cell) {
  if (cell === undefined || cell === null) return CELL_MISSING;
  // A BARE SCALAR, not a cell object. Payloads written before the three-state
  // contract existed stored the value directly, and an old ins_extractions row
  // is never rewritten (the table is insert-only), so this branch is permanent
  // rather than transitional. A value that is on the page is a value.
  if (!isCell(cell)) return "value";
  // A state nobody recognises reads as `unreadable`, never as `value`. Falling
  // the other way would let a malformed cell render as a confident blank, which
  // is the exact failure the three states exist to prevent.
  if (!CELL_STATES.includes(cell.state)) return "unreadable";
  // And a cell claiming `value` with nothing in it is malformed the same way,
  // so it falls the same direction. A `value` state is a claim that the page
  // says something; carrying no value is a claim that it says nothing, and the
  // two together are not a reading. Read as `value` it would beat a populated
  // ins_policies column in resolveField and blank the carrier the owner typed —
  // "the document is silent" wearing the one state that outranks the owner.
  if (cell.state === "value" && (cell.value === null || cell.value === undefined)) return "unreadable";
  return cell.state;
}

// The value of a cell, or null.
export function cellValue(cell) {
  if (cellState(cell) !== "value") return null;   // a leftover value carried alongside
  if (!isCell(cell)) return cell;                 // `not_stated_in_document` must not leak out
  return cell.value === undefined ? null : cell.value;
}

// Which page the cell was read from, for the citation. Bare-scalar payloads
// carry no page, which is one reason the cell shape replaced them.
export function cellPage(cell) {
  if (!isCell(cell)) return null;
  // A type check before the finite check, and for the reason renewalTiers gives
  // below: Number(null), Number(""), Number(false) and Number([]) are all 0,
  // and `page: null` is the ordinary shape for a field nobody could cite — the
  // test factory's own default. Read as page 0 it becomes a citation, and a
  // citation to page 0 is a citation to nothing: brief §4 makes
  // (document_id, page) the mechanism that stops confident invention, so a page
  // nobody stated has to come back as no page rather than as the first one.
  const raw = cell.page;
  if (typeof raw !== "number" && (typeof raw !== "string" || raw.trim() === "")) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// -- Field resolution ---------------------------------------------------------

// Field paths that correspond to a real ins_policies column, and can therefore
// fall through to the owner-maintained spine. Anything else (a dotted path into
// a coverage line, say) has no column to fall back to.
const POLICY_COLUMNS = new Set([
  "nickname", "carrier", "product", "kind", "policy_number",
  "term_start", "term_end", "term_months", "term_premium",
  "payment_channel", "verified_on", "notes",
]);

// The fields resolvePolicyView resolves, in render order. Two of them —
// named_insured and risk_address — exist only in extractions; they have no
// column on ins_policies and resolve to `none` until a document says otherwise.
export const RESOLVED_FIELDS = [
  "nickname", "carrier", "product", "kind", "policy_number",
  "named_insured", "risk_address", "mailing_address",
  "term_start", "term_end", "term_months", "term_premium",
  "payment_channel", "verified_on", "notes",
];

// Fields no document can state, so no extraction is allowed to answer them —
// the same reasoning resolvePolicyView applies to status and
// supersedes_policy_id, which is that a fact about the OWNER is not a fact the
// page can contain. `verified_on` is stamped by the commit flow and records
// that a person checked, not anything a carrier printed; `notes` is the owner's
// own prose; `nickname` is what the household calls the policy ("USAA FL
// homeowners"), and it is not in the ExtractionPayload contract above at all.
// Each of the three is still overridable and still falls through to its
// ins_policies column — what is removed is only the extraction's turn, because
// a cell that did somehow carry one of these would OUTRANK the column and
// overwrite the owner's own words with the model's.
//
// A field in here reports `missing` rather than a document state when nothing
// fills it, which is the honest reading: "nobody has filled this in" is the
// only answer available for a question no document was ever asked.
const OWNER_ONLY_FIELDS = new Set(["nickname", "verified_on", "notes"]);

// Dotted path lookup, so an override can pin `coverages.0.limit_value` and not
// just a top-level cell. Numeric segments index arrays.
function getPath(obj, path) {
  let cur = obj;
  for (const key of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

// Accepts either an ins_extractions ROW (with a .payload) or a bare payload,
// because resolvePolicyView merges several rows into one synthetic payload and
// routes will hand over rows straight from the repository.
const payloadOf = (extraction) => {
  if (!extraction || typeof extraction !== "object") return null;
  return extraction.payload && typeof extraction.payload === "object" ? extraction.payload : extraction;
};

// An override row for this field, or undefined. `overrides` is the array of
// ins_overrides rows for the policy.
//
// PRESENCE is what counts, not truthiness: a row whose value is JSON null is
// the owner saying "I checked, this field is genuinely blank", and it has to
// beat the extraction like any other override. That is the whole reason
// ins_overrides.value is JSONB and not TEXT.
const findOverride = (overrides, fieldPath) =>
  (Array.isArray(overrides) ? overrides : []).find((o) => o?.field_path === fieldPath);

// Resolve one field to a single answer plus where it came from.
//
// Precedence is override > extraction > policy column > none, with one
// refinement that follows from the same principle rather than bending it: an
// extraction only ANSWERS when its cell state is `value`. A cell that is
// missing, `not_stated_in_document` or `unreadable` does not overwrite a
// populated policy column — a document that never mentions the nickname must
// not blank the nickname the owner typed, and for the three OWNER_ONLY_FIELDS
// not even a cell that claims to state one gets a turn. When the column is
// empty too, the state reported is the EXTRACTION's, not a bare `missing`,
// because "the document does not say" and "nobody has filled this in" are
// different prompts to the reader and only one of them means "call the
// carrier".
export function resolveField(fieldPath, { policy, overrides, extraction } = {}) {
  const override = findOverride(overrides, fieldPath);
  if (override) {
    // The owner's assertion is a value, including the assertion that the field
    // is blank. It is never `not_stated_in_document`: that state is a claim
    // about a document, and this is a claim about the world.
    return { value: override.value === undefined ? null : override.value, state: "value", source: "override", page: null };
  }

  const payload = OWNER_ONLY_FIELDS.has(fieldPath) ? null : payloadOf(extraction);
  const cell = payload ? getPath(payload, fieldPath) : undefined;
  const state = cellState(cell);
  if (state === "value") {
    return { value: cellValue(cell), state: "value", source: "extraction", page: cellPage(cell) };
  }

  if (POLICY_COLUMNS.has(fieldPath)) {
    const columnValue = policy?.[fieldPath];
    if (columnValue !== undefined && columnValue !== null && columnValue !== "") {
      return { value: columnValue, state: "value", source: "policy", page: null };
    }
  }

  // Nothing has a value. Carry the extraction's state through if it had one, so
  // "the coverage screen does not state a term" survives all the way to the UI.
  return { value: null, state, source: "none", page: cellPage(cell) };
}

// -- Merging several extractions ----------------------------------------------

// One synthetic payload from every extraction attached to a policy's documents.
//
// Two tie-breaks, in order:
//
//   1. WITHIN a document, the highest prompt_version wins outright. A newer
//      prompt is a better reading of the same bytes, and the older row survives
//      in the table only because a finding may cite it.
//   2. ACROSS documents, the most recently EXTRACTED document wins, with the
//      higher document_id breaking a tie (rows written in one batch share a
//      timestamp, and id order is insertion order). Newest-first is the right
//      direction here because a renewal declarations page supersedes last
//      year's, and re-uploading the same file cannot happen — ins_documents
//      dedupes on sha256.
//
// A field is taken from the first extraction in that order whose cell states
// `value`; failing that, from the first that says anything about the field at
// all, so `not_stated_in_document` is preserved instead of decaying to
// `missing`. List sections take the first non-empty one, whole — a coverage
// schedule half from this year and half from last is not a schedule.
export function mergeExtractions(extractions = []) {
  const rows = (Array.isArray(extractions) ? extractions : []).filter((r) => payloadOf(r));

  const bestPerDocument = new Map();
  for (const row of rows) {
    const docId = row.document_id ?? row.documentId ?? null;
    const key = docId === null ? `row:${rows.indexOf(row)}` : `doc:${docId}`;
    const prior = bestPerDocument.get(key);
    if (!prior || Number(row.prompt_version ?? 0) > Number(prior.prompt_version ?? 0)) bestPerDocument.set(key, row);
  }

  const ordered = [...bestPerDocument.values()].sort((a, b) => {
    // toInstant, never String(): see its comment. A Date stringified here sorts
    // by weekday name and hands the merge to last year's declarations page.
    const at = toInstant(a.extracted_at);
    const bt = toInstant(b.extracted_at);
    if (at !== bt) {
      // A row nobody can date cannot claim to be the newest reading, so it
      // sorts behind every row that can — the same call renewalCalendar makes
      // for a policy with no term_end.
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt - at;
    }
    return Number(b.document_id ?? 0) - Number(a.document_id ?? 0);
  });

  const merged = {};
  for (const row of ordered) {
    const payload = payloadOf(row);
    for (const [key, cell] of Object.entries(payload)) {
      if (LIST_SECTIONS.includes(key)) {
        if (Array.isArray(cell) && cell.length && !merged[key]?.length) merged[key] = cell;
        continue;
      }
      const state = cellState(cell);
      if (state === CELL_MISSING) continue;
      const held = cellState(merged[key]);
      if (held === "value") continue;                       // an earlier, newer row already answered
      if (state === "value" || held === CELL_MISSING) merged[key] = cell;
    }
  }
  for (const key of LIST_SECTIONS) if (!Array.isArray(merged[key])) merged[key] = [];
  return merged;
}

// The merged read model for one policy: every field resolved, the provenance of
// each kept alongside, and the annualized premium computed from whatever the
// resolution actually produced.
//
// `fields` is the part that makes the preview/commit review possible — it says,
// per field, whether the number on screen came from the owner, from a document
// (and which page), or from nowhere at all.
//
// CALLERS MUST NOT RENDER THE FLAT VALUES DIRECTLY. `view.term_end` and its
// neighbours come from the `...values` spread below, which flattens all three
// non-value states to the same null: "the coverage screen does not state a
// term", "the scan of that page is unreadable" and "no document has ever
// mentioned it" arrive as one indistinguishable blank. The distinction survives
// only in `view.fields[path].state`, and rendering the flat value is both the
// obvious thing to do and precisely how "go confirm this with the carrier"
// decays into an empty cell — the failure the three states exist to prevent and
// the one the workbook's Open Items r16 was written about. Read the value for
// arithmetic; read `fields` for anything a person will look at.
export function resolvePolicyView({ policy, overrides = [], extractions = [] } = {}) {
  const merged = mergeExtractions(extractions);

  const fields = {};
  for (const path of RESOLVED_FIELDS) fields[path] = resolveField(path, { policy, overrides, extraction: merged });

  const values = {};
  for (const [path, resolved] of Object.entries(fields)) values[path] = resolved.value;

  const premium = annualizePremium({ termPremium: values.term_premium, termMonths: values.term_months });

  return {
    id: policy?.id ?? null,
    // status and supersedes_policy_id are owner-only in the strongest sense: no
    // document states which policy replaced which, so neither is resolvable and
    // neither is offered as an overridable field. verified_on, notes and
    // nickname are owner-only in the weaker sense — they are resolved and
    // overridable, but no extraction gets a turn at them (OWNER_ONLY_FIELDS).
    status: policy?.status ?? null,
    supersedes_policy_id: policy?.supersedes_policy_id ?? null,
    ...values,
    annual_premium: premium.annual,
    annual_premium_state: premium.state,
    document_kind: merged.document_kind ?? null,
    coverages: merged.coverages,
    deductibles: merged.deductibles,
    forms_schedule: merged.forms_schedule,
    credits: merged.credits,
    fields,
  };
}

// -- Premiums -----------------------------------------------------------------

// What this policy costs for a year, from the term as printed.
//
// Cost Detail r2: "Six-month auto premiums are doubled." Six doubles, twelve is
// unchanged, and anything else scales by 12/n — a three-month binder and a
// surplus-lines off-cycle term are both real.
//
// An unknown or non-finite term length returns null and SAYS SO. It never
// guesses 12. Two of the six real policies are coverage screens with no stated
// term, and a $1,900 six-month auto premium silently reported as $1,900 a year
// understates the program by nearly two thousand dollars while looking
// perfectly plausible — which is worse than a total that admits it is
// incomplete, and is why rollup() carries unknown_count.
export function annualizePremium({ termPremium, termMonths } = {}) {
  const premium = money(termPremium);
  if (premium === null) return { annual: null, state: "premium-unknown" };
  const months = money(termMonths);
  if (months === null || months <= 0) return { annual: null, state: "term-months-unknown" };
  if (months === 12) return { annual: round2(premium), state: "value" };
  return { annual: round2(premium * (12 / months)), state: "value" };
}

// The annual cost of a policy however it reaches us: a resolvePolicyView result
// carries its own decision (including the decision that it is unknown, which
// must not be recomputed and quietly answered differently), and a raw
// ins_policies row is annualized here.
function policyAnnual(policy) {
  if (policy && typeof policy === "object" && "annual_premium_state" in policy) {
    return typeof policy.annual_premium === "number" && Number.isFinite(policy.annual_premium)
      ? policy.annual_premium
      : null;
  }
  return annualizePremium({ termPremium: policy?.term_premium, termMonths: policy?.term_months }).annual;
}

// Sum a set of policies, counting rather than swallowing the ones whose annual
// cost nobody knows.
function sumAnnual(policies = []) {
  let annual = 0;
  let unknown = 0;
  for (const policy of policies) {
    const value = policyAnnual(policy);
    if (value === null) unknown += 1;
    else annual += value;
  }
  return {
    annual: round2(annual),
    monthly: round2(annual / 12),
    unknown_count: unknown,
    count: policies.length,
  };
}

// The label a policy groups under when its grouping key is empty. A rollup row
// with no label reads as a bug; a row labelled "(unspecified)" reads as the
// data-entry gap it is.
export const UNSPECIFIED_KEY = "(unspecified)";

// Premium grouped by anything: carrier (the workbook's Cost Detail), payment
// channel (which is how the escrowed-through-Chase question gets answered), or
// kind.
//
// unknown_count is not decoration. A policy with no derivable annual premium is
// COUNTED here and never summed as 0: a total that quietly omits a policy is
// worse than one that says it is incomplete, because the first is indis-
// tinguishable from a correct total and the second prompts the phone call.
//
// Sorted by annual descending then key ascending — deterministic, because this
// is rendered as a table and a group order that depends on Map insertion (and
// therefore on row order out of Postgres) makes a stable page look unstable.
export function rollup(policies = [], keyFn = (p) => p?.carrier) {
  const groups = new Map();
  for (const policy of policies) {
    const raw = typeof keyFn === "function" ? keyFn(policy) : null;
    const key = raw === null || raw === undefined || String(raw).trim() === "" ? UNSPECIFIED_KEY : String(raw);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(policy);
  }

  return [...groups.entries()]
    .map(([key, members]) => {
      const totals = sumAnnual(members);
      return {
        key,
        annual: totals.annual,
        monthly: totals.monthly,
        unknown_count: totals.unknown_count,
        // Carried for the same reason programTotals carries it: "3 policies,
        // one of them unpriced" is a readable row and "unknown_count: 1" on its
        // own is not, and members.length is not the caller's job to take.
        count: totals.count,
        policies: members,
      };
    })
    .sort((a, b) => (b.annual - a.annual) || a.key.localeCompare(b.key));
}

// -- Before / after -----------------------------------------------------------

// The two sides of the restructuring the workbook narrates.
//
// `quoted` and `declined` are in NEITHER set, on purpose. A quote is not yet a
// cost and a declined quote never will be, but the declined row is kept in the
// table because it records why the cheaper-looking option was turned down —
// which is worth reading and is not worth adding to a total.
export const BEFORE_STATUSES = ["replaced", "cancelled"];
export const AFTER_STATUSES = ["in_force", "replacing"];

const inSet = (statuses, policy) => statuses.includes(policy?.status);

// What the program costs now versus what it cost before, with the unknowns
// carried through to the delta. A delta computed over a set containing an
// unpriced policy is not wrong, it is incomplete, and the caller has to be able
// to tell the difference.
export function programTotals(policies = []) {
  const before = sumAnnual(policies.filter((p) => inSet(BEFORE_STATUSES, p)));
  const after = sumAnnual(policies.filter((p) => inSet(AFTER_STATUSES, p)));
  return {
    before,
    after,
    delta: {
      annual: round2(after.annual - before.annual),
      monthly: round2((after.annual - before.annual) / 12),
      unknown_count: before.unknown_count + after.unknown_count,
    },
  };
}

// The workbook's Cost Detail, row for row: each replacement paired with what it
// replaced, plus the rows that legitimately exist on only one side.
//
// Pairing runs from the AFTER side through supersedes_policy_id. An after
// policy whose pointer names a policy that is not in the before set (it was
// deleted, or it is still in force) is reported as `added` rather than dropped
// silently — an unresolvable pointer must not remove a real cost from the
// comparison. Before rows nothing claims to replace are `dropped`, which is the
// coverage that went away and the case worth looking at hardest.
export function compareProgram(policies = []) {
  const before = policies.filter((p) => inSet(BEFORE_STATUSES, p));
  const after = policies.filter((p) => inSet(AFTER_STATUSES, p));
  const beforeById = new Map(before.map((p) => [String(p.id), p]));

  const claimed = new Set();
  const rows = [];

  for (const policy of after) {
    const priorId = policy.supersedes_policy_id === null || policy.supersedes_policy_id === undefined
      ? null
      : String(policy.supersedes_policy_id);
    // A prior policy can only be claimed once: two replacements pointing at the
    // same predecessor would otherwise subtract its premium twice.
    const prior = priorId !== null && !claimed.has(priorId) ? beforeById.get(priorId) : undefined;
    if (prior) claimed.add(priorId);
    rows.push(compareRow(prior ?? null, policy, prior ? "replaced" : "added"));
  }

  for (const policy of before) {
    if (claimed.has(String(policy.id))) continue;
    rows.push(compareRow(policy, null, "dropped"));
  }

  return rows;
}

function compareRow(before, after, change) {
  const annualBefore = before ? policyAnnual(before) : null;
  const annualAfter = after ? policyAnnual(after) : null;
  // An unknown side makes the delta unknown rather than making it look like the
  // whole premium appeared or vanished.
  const known = (before ? annualBefore !== null : true) && (after ? annualAfter !== null : true);
  return {
    key: after ? `after:${after.id}` : `before:${before.id}`,
    change,
    before: before ?? null,
    after: after ?? null,
    annual_before: annualBefore,
    annual_after: annualAfter,
    annual_delta: known ? round2((annualAfter ?? 0) - (annualBefore ?? 0)) : null,
    unknown: !known,
  };
}

// -- Renewals -----------------------------------------------------------------

// One entry per policy, INCLUDING the ones with no term_end. That is the whole
// requirement: a policy whose term is not stated has to render as "term unknown
// — confirm with carrier", never as no upcoming renewal, because the two
// Progressive policies are exactly that case and silence about them is how a
// lapse happens.
//
// Sorted soonest-first with the undated policies LAST — they cannot sort by a
// date they do not have, and sorting them to the top (which is where a null
// coerced to epoch would put them) would bury the renewal that is actually
// imminent.
export function renewalCalendar(policies = [], today) {
  const now = parts(today);
  if (!now) throw new Error("renewalCalendar requires today as YYYY-MM-DD");

  return policies
    .map((policy) => {
      const renewal = parts(policy?.term_end);
      return {
        policy_id: policy?.id ?? null,
        renewal_date: renewal ? toDateString(policy.term_end) : null,
        days_until: renewal ? daysBetween(now, renewal) : null,
        term_known: Boolean(renewal),
        status: policy?.status ?? null,
      };
    })
    .sort((a, b) => {
      if (a.term_known !== b.term_known) return a.term_known ? -1 : 1;
      if (!a.term_known) return Number(a.policy_id) - Number(b.policy_id);
      return a.days_until - b.days_until || Number(a.policy_id) - Number(b.policy_id);
    });
}

// Statuses that never produce a reminder. A declined quote has no renewal, and
// a replaced or cancelled policy renewing is not an event — chasing either one
// trains the mailbox to ignore this sender, which is what costs the reminder
// that mattered.
const NEVER_ALERT_STATUSES = new Set(["declined", "replaced", "cancelled"]);

// Lead times, in days. 60 is enough to shop or to give notice; 14 is the last
// point at which a lapse is still comfortably avoidable — Open Items r8 is a
// sequencing risk between a cancellation and an inception date, and it carries
// real money in both directions ("a lapse breaks the RLI Basic Policy
// condition; an overlap costs money").
export const RENEWAL_THRESHOLDS = [60, 14];

// Which reminders are DUE for a policy today. Whether one has already been sent
// is ins_alerts' business (policy_id, renewal_date, tier) — this only decides
// what would be worth saying. The structural twin of alertTiers in
// benefits/periods.js:635, including its ordering: ascending urgency, so a
// caller that has already sent renewal-60d takes the next unsent tier.
export function renewalTiers({ policy, daysUntil, termKnown, status } = {}) {
  const effectiveStatus = status ?? policy?.status ?? null;
  if (NEVER_ALERT_STATUSES.has(effectiveStatus)) return [];

  // The analogue of alertTiers' `rule-error` tier. A policy nobody can date
  // cannot be counted down to, and silence about it is precisely how the two
  // undated Progressive policies would go a year without anyone confirming
  // their term. One tier, so ins_alerts' (policy_id, renewal_date, tier) caps
  // it at one message per renewal date rather than one a day.
  const known = termKnown === undefined ? Boolean(parts(policy?.term_end)) : Boolean(termKnown);
  if (!known) return ["term-unknown"];

  // An explicit finite-number check, not a null guard, and for the reason
  // alertTiers gives: Number(null), Number(""), Number(false) and Number([])
  // are all 0, so a policy with no countdown would read as "renews today" and
  // fire every tier it has.
  const days = Number.isFinite(daysUntil) ? daysUntil : NaN;

  // A renewal date in the past is a stale record, not a countdown: either the
  // policy renewed and nobody updated the term, or it lapsed. Neither is a
  // lead-time reminder, so no `renewal-Nd` tier fires — but this is where the
  // resemblance to alertTiers STOPS, and copying its silence here would be
  // wrong. alertTiers can stay quiet because resolvePeriod recomputes the
  // period on every read, so a benefit's period_end is never durably in the
  // past; insurance term_end is an owner-maintained column that nothing
  // recomputes, so a stale date sits there indefinitely and the owner goes on
  // believing they are covered through a date that has gone. That is the worse
  // lapse state of the two this function knows about — an undated policy at
  // least gets `term-unknown` — and Open Items r8 prices it ("a lapse breaks
  // the RLI Basic Policy condition"). So it gets a tier of its own, structurally
  // the twin of `term-unknown` above and of alertTiers' `rule-error`: worth
  // saying once, and capped at once by ins_alerts (policy_id, renewal_date,
  // tier). The never-alert statuses above still return [] — a replaced policy
  // whose term has passed is the expected end of that policy, not news.
  if (!Number.isFinite(days)) return [];
  if (days < 0) return ["term-stale"];

  return RENEWAL_THRESHOLDS.filter((t) => days <= t).map((t) => `renewal-${t}d`);
}

// -- Forms schedules ----------------------------------------------------------

// Carriers print the same form code with inconsistent spacing and case
// ("HO-225FL", "ho-225fl  "), and a diff keyed on the raw string would report
// one dropped and one added for a form that never moved.
const formKey = (form) => String(form?.code ?? "").trim().toUpperCase();

// And the edition is normalised the same way, for the same reason. "09-16" and
// " 09-16" are one edition printed twice; compared raw they report a `revised`,
// which reads as "the wording that defines this coverage changed" and sends
// someone to re-read a form that never moved. On a path whose whole value is
// that its findings are arithmetic rather than judgment, a false positive is
// expensive in a way a formatting difference should never be.
const editionKey = (edition) => String(edition ?? "").trim().toUpperCase();

// Year-over-year set difference between two forms schedules.
//
// This is the strongest deterministic win in the brief and it involves no model
// at all: the workbook's URGENT finding ("Restore Ordinance or Law coverage at
// 25%, HO-225FL") and its Resolved r7 ("Not in the 2026-27 form schedule") are
// both this function's output. An endorsement that disappears between terms is
// caught with 100% recall OF THE ENTRIES THAT CARRY A FORM CODE, which is a far
// stronger guarantee than anything the analysis tier can offer — but the
// qualifier is the honest version of the claim, because the diff is keyed on
// the code and an entry with no code cannot be keyed at all. Those come back in
// `codeless` rather than being dropped: a schedule line the extractor read as a
// title with no code is a gap in the reading, and silently returning four empty
// buckets for it is the same confident blank the cell states exist to prevent.
// `codeless` entries are in none of added/dropped/retained/revised, and a
// caller that renders the diff has to render them too or it is showing a recall
// guarantee it does not have.
//
// A code present in both lists is RETAINED. If its edition changed it is also
// reported in `revised` — retained-but-revised, because the coverage is still
// there but the wording that defines it is not the wording anyone last read.
// `revised` is therefore a subset of `retained`, never an alternative to it.
//
// The carrier's own `disposition` ("REMAINS IN EFFECT" / "ADDED") is preserved
// on the returned forms but is NOT what the diff is computed from: it is the
// carrier's claim relative to a term we may not hold, and the point of this
// function is to compare the two schedules we actually have.
//
// First occurrence of a duplicated code wins, so a schedule that lists a form
// twice diffs as one form rather than producing a phantom add.
export function diffFormsSchedules(priorList = [], currentList = []) {
  const codeless = [];
  // `side` travels with the entry because it changes what the gap means: a
  // codeless line in the CURRENT schedule may be a form that is present and
  // unnameable, and one in the PRIOR schedule may be a drop nobody can report.
  const index = (list, side) => {
    const map = new Map();
    for (const form of Array.isArray(list) ? list : []) {
      const key = formKey(form);
      if (!key) {
        codeless.push({ side, form });
        continue;
      }
      if (!map.has(key)) map.set(key, form);
    }
    return map;
  };
  const prior = index(priorList, "prior");
  const current = index(currentList, "current");

  const added = [];
  const dropped = [];
  const retained = [];
  const revised = [];

  for (const [key, form] of current) {
    if (!prior.has(key)) {
      added.push(form);
      continue;
    }
    const priorForm = prior.get(key);
    retained.push(form);
    const priorEdition = priorForm?.edition ?? null;
    const currentEdition = form?.edition ?? null;
    if (editionKey(priorEdition) !== editionKey(currentEdition)) {
      revised.push({ code: key, prior_edition: priorEdition, current_edition: currentEdition, prior: priorForm, current: form });
    }
  }

  for (const [key, form] of prior) if (!current.has(key)) dropped.push(form);

  return { added, dropped, retained, revised, codeless };
}
