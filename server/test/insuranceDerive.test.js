import test from "node:test";
import assert from "node:assert/strict";
import {
  cellValue, cellState, cellPage, CELL_MISSING,
  resolveField, resolvePolicyView, mergeExtractions,
  annualizePremium, rollup, programTotals, compareProgram,
  renewalCalendar, renewalTiers, diffFormsSchedules,
  UNSPECIFIED_KEY,
} from "../insurance/derive.js";

// The derive half of insurance tracking: what a term premium costs for a year,
// which policy replaced which, when the next renewal lands, and which
// endorsement quietly disappeared between terms. No pg, no express, no network
// — derive.js imports nothing at all, which is what lets this file run with
// nothing else in the process.
//
// Three properties are load bearing here, and each has a named test below:
//
//   - a field the document does not state must not render as a blank. The
//     Progressive coverage screens state no policy term, and "go confirm this"
//     and "blank" are different answers;
//   - a premium whose term length is unknown must never be annualized by
//     assuming twelve months, and a rollup containing one must say it is
//     incomplete rather than quietly report a smaller number;
//   - a policy with no term_end must still appear in the renewal calendar,
//     because a policy nobody can date is exactly the one that lapses.

const policy = (over = {}) => ({
  id: 1,
  nickname: "USAA FL homeowners",
  carrier: "USAA",
  product: "Homeowners",
  kind: "home",
  policy_number: "HO-1234",
  term_start: "2026-10-12",
  term_end: "2027-10-12",
  term_months: 12,
  term_premium: 3200,
  payment_channel: "Chase mortgage escrow",
  status: "in_force",
  supersedes_policy_id: null,
  verified_on: null,
  notes: null,
  ...over,
});

const cell = (value, state = "value", page = null) => ({ value, state, page });

const extraction = (payload, over = {}) => ({
  document_id: 1, prompt_version: 1, model: "gemini-2.5-flash",
  extracted_at: "2026-09-01T00:00:00.000Z", payload, ...over,
});

// -- Cells --------------------------------------------------------------------

test("a cell reports its own state, and an absent cell reports missing", () => {
  assert.equal(cellState(cell("USAA")), "value");
  assert.equal(cellValue(cell("USAA")), "USAA");

  // The Progressive case. The document was read and the term is not on it —
  // which is an answer, and a different answer from "nobody looked".
  const absent = cell(null, "not_stated_in_document", 2);
  assert.equal(cellState(absent), "not_stated_in_document");
  assert.equal(cellValue(absent), null);
  assert.equal(cellPage(absent), 2);

  const unreadable = cell(null, "unreadable", 6);
  assert.equal(cellState(unreadable), "unreadable");
  assert.equal(cellValue(unreadable), null);

  // Not in the payload at all: the model did not answer the question.
  assert.equal(cellState(undefined), CELL_MISSING);
  assert.equal(cellState(null), CELL_MISSING);
  assert.equal(cellValue(undefined), null);

  // A value carried alongside a non-value state must not leak out — otherwise a
  // stale extraction renders a number the page does not contain.
  assert.equal(cellValue({ value: "LEFTOVER", state: "not_stated_in_document" }), null);
});

test("a bare scalar from an older payload reads as a value, not as missing", () => {
  // ins_extractions is insert-only, so a row written before the three-state
  // cell contract existed is never rewritten and this branch is permanent.
  assert.equal(cellState("Progressive"), "value");
  assert.equal(cellValue("Progressive"), "Progressive");
  assert.equal(cellPage("Progressive"), null);
  assert.equal(cellState(0), "value");
  assert.equal(cellValue(0), 0);

  // A state nobody recognises falls to unreadable, never to value: a malformed
  // cell rendering as a confident blank is the failure the states prevent.
  assert.equal(cellState({ value: "x", state: "totally-new" }), "unreadable");
  assert.equal(cellValue({ value: "x", state: "totally-new" }), null);
});

// -- Field resolution ---------------------------------------------------------

test("an override beats the extraction, which beats the policy column", () => {
  const payload = { carrier: cell("Progressive", "value", 1), policy_number: cell("PGR-9", "value", 1) };

  const fromPolicy = resolveField("nickname", { policy: policy(), overrides: [], extraction: extraction(payload) });
  assert.deepEqual(fromPolicy, { value: "USAA FL homeowners", state: "value", source: "policy", page: null });

  const fromExtraction = resolveField("carrier", { policy: policy(), overrides: [], extraction: extraction(payload) });
  assert.deepEqual(fromExtraction, { value: "Progressive", state: "value", source: "extraction", page: 1 });

  const fromOverride = resolveField("carrier", {
    policy: policy(),
    overrides: [{ field_path: "carrier", value: "Progressive Casualty" }],
    extraction: extraction(payload),
  });
  assert.deepEqual(fromOverride, { value: "Progressive Casualty", state: "value", source: "override", page: null });
});

test("an override of JSON null is a deliberate blank and still wins", () => {
  // The reason ins_overrides.value is JSONB and not TEXT: the owner checked,
  // and the field really is empty. That has to beat a confident extraction,
  // and it must not read as "no override recorded".
  const resolved = resolveField("policy_number", {
    policy: policy(),
    overrides: [{ field_path: "policy_number", value: null, note: "carrier confirmed none issued" }],
    extraction: extraction({ policy_number: cell("HO-9999") }),
  });
  assert.deepEqual(resolved, { value: null, state: "value", source: "override", page: null });

  // And 0 and "" are three different assertions from null, all of them stored.
  assert.equal(resolveField("term_premium", {
    policy: policy(), overrides: [{ field_path: "term_premium", value: 0 }],
  }).value, 0);
  assert.equal(resolveField("notes", {
    policy: policy(), overrides: [{ field_path: "notes", value: "" }],
  }).value, "");
});

test("a field the document does not state falls back, and keeps saying so when nothing fills it", () => {
  // A coverage screen that never mentions the nickname must not blank the
  // nickname the owner typed …
  const payload = { nickname: cell(null, "not_stated_in_document", 1), term_end: cell(null, "not_stated_in_document", 1) };
  const kept = resolveField("nickname", { policy: policy(), extraction: extraction(payload) });
  assert.equal(kept.value, "USAA FL homeowners");
  assert.equal(kept.source, "policy");

  // … and where the column is empty too, the answer is "the document does not
  // say", not a bare blank. This is the difference between rendering nothing and
  // rendering "confirm with carrier".
  const undated = resolveField("term_end", { policy: policy({ term_end: null }), extraction: extraction(payload) });
  assert.deepEqual(undated, { value: null, state: "not_stated_in_document", source: "none", page: 1 });

  // Nothing anywhere is `missing`, which is a different prompt to the reader.
  const nothing = resolveField("term_end", { policy: policy({ term_end: null }), extraction: extraction({}) });
  assert.deepEqual(nothing, { value: null, state: CELL_MISSING, source: "none", page: null });
});

test("the newest prompt version wins within a document, the newest document across them", () => {
  const merged = mergeExtractions([
    extraction({ carrier: cell("USAA"), term_premium: cell(3000) }, { document_id: 1, prompt_version: 1 }),
    // Same document, better prompt: this is the reading that counts, and the
    // older row survives in the table only because a finding may cite it.
    extraction({ carrier: cell("USAA Casualty"), term_premium: cell(3200) }, { document_id: 1, prompt_version: 2 }),
    // A later document says nothing about the carrier, so it does not erase it.
    extraction({ carrier: cell(null, "not_stated_in_document", 1), policy_number: cell("HO-777") },
      { document_id: 2, prompt_version: 1, extracted_at: "2026-09-05T00:00:00.000Z" }),
  ]);
  assert.equal(cellValue(merged.carrier), "USAA Casualty");
  assert.equal(cellValue(merged.term_premium), 3200);
  assert.equal(cellValue(merged.policy_number), "HO-777");
});

test("resolvePolicyView merges the policy, the extraction and the overrides with provenance", () => {
  const view = resolvePolicyView({
    policy: policy({ term_premium: null, term_months: null }),
    overrides: [{ field_path: "payment_channel", value: "annual ACH" }],
    extractions: [extraction({
      carrier: cell("USAA", "value", 6),
      risk_address: cell("20007 LARINO LOOP, ESTERO, LEE, FL", "value", 6),
      // Page 1 shows Herriman UT. Both are extracted, and they are not the same
      // field — collapsing them files the Florida policy under the Utah house.
      mailing_address: cell("HERRIMAN UT 84096", "value", 1),
      term_premium: cell(3200, "value", 6),
      term_months: cell(12, "value", 6),
      forms_schedule: [{ code: "HO-3RFL", edition: "09-16", title: "HOMEOWNERS SPECIAL FORM", disposition: "remains", page: 7 }],
    })],
  });

  assert.equal(view.id, 1);
  assert.equal(view.carrier, "USAA");
  assert.equal(view.risk_address, "20007 LARINO LOOP, ESTERO, LEE, FL");
  assert.notEqual(view.risk_address, view.mailing_address);
  assert.equal(view.payment_channel, "annual ACH");
  assert.equal(view.annual_premium, 3200);
  assert.equal(view.annual_premium_state, "value");

  assert.equal(view.fields.carrier.source, "extraction");
  assert.equal(view.fields.carrier.page, 6);
  assert.equal(view.fields.payment_channel.source, "override");
  assert.equal(view.fields.nickname.source, "policy");
  assert.equal(view.forms_schedule.length, 1);
  assert.deepEqual(view.coverages, []);          // absent sections normalize to []
});

// -- Premiums -----------------------------------------------------------------

test("a six-month premium doubles, twelve months is unchanged, and other terms scale", () => {
  // Cost Detail r2: "Six-month auto premiums are doubled."
  assert.deepEqual(annualizePremium({ termPremium: 950.5, termMonths: 6 }), { annual: 1901, state: "value" });
  assert.deepEqual(annualizePremium({ termPremium: 3200, termMonths: 12 }), { annual: 3200, state: "value" });
  assert.deepEqual(annualizePremium({ termPremium: 300, termMonths: 3 }), { annual: 1200, state: "value" });
  // As the carrier prints it.
  assert.equal(annualizePremium({ termPremium: "$1,234.00", termMonths: "12" }).annual, 1234);
});

test("an unknown term length yields null, never a guess of twelve months", () => {
  for (const termMonths of [null, undefined, "", "unknown", NaN, 0, -6]) {
    const result = annualizePremium({ termPremium: 1900, termMonths });
    assert.equal(result.annual, null, `termMonths ${String(termMonths)} must not annualize`);
    assert.equal(result.state, "term-months-unknown");
  }
  // A $1,900 six-month auto premium reported as $1,900/yr understates the
  // program by nearly two thousand dollars while looking entirely plausible.
  assert.notEqual(annualizePremium({ termPremium: 1900, termMonths: null }).annual, 1900);

  assert.deepEqual(annualizePremium({ termPremium: null, termMonths: 6 }), { annual: null, state: "premium-unknown" });
});

// -- Rollups ------------------------------------------------------------------

test("a rollup counts an unpriced policy instead of silently summing it as zero", () => {
  const rows = rollup([
    policy({ id: 1, carrier: "USAA", term_premium: 3200, term_months: 12 }),
    policy({ id: 2, carrier: "USAA", term_premium: 1800, term_months: 12 }),
    // The Progressive coverage screen: a premium on the page, no term anywhere.
    policy({ id: 3, carrier: "Progressive", term_premium: 950, term_months: null }),
    policy({ id: 4, carrier: "Progressive", term_premium: 700, term_months: 6 }),
    policy({ id: 5, carrier: null, term_premium: 400, term_months: 12 }),
  ], (p) => p.carrier);

  assert.deepEqual(rows.map((r) => r.key), ["USAA", "Progressive", UNSPECIFIED_KEY]);

  const usaa = rows.find((r) => r.key === "USAA");
  assert.equal(usaa.annual, 5000);
  assert.equal(usaa.monthly, 416.67);
  assert.equal(usaa.unknown_count, 0);
  assert.equal(usaa.policies.length, 2);

  const progressive = rows.find((r) => r.key === "Progressive");
  assert.equal(progressive.annual, 1400);        // the six-month term, doubled …
  assert.equal(progressive.unknown_count, 1);    // … and the undated one COUNTED, not summed as 0
  assert.equal(progressive.policies.length, 2);

  // Grouping by anything: payment channel answers "what is escrowed?".
  const byChannel = rollup([
    policy({ id: 1, payment_channel: "Chase mortgage escrow", term_premium: 3200, term_months: 12 }),
    policy({ id: 2, payment_channel: "direct draft", term_premium: 1200, term_months: 12 }),
  ], (p) => p.payment_channel);
  assert.deepEqual(byChannel.map((r) => r.key), ["Chase mortgage escrow", "direct draft"]);
});

// -- Before / after -----------------------------------------------------------

const PROGRAM = [
  // Paired: the USAA policy that was replaced, and what replaced it.
  policy({ id: 1, nickname: "old home", carrier: "Homesite", status: "replaced", term_premium: 2400, term_months: 12 }),
  policy({ id: 2, nickname: "new home", carrier: "USAA", status: "in_force", term_premium: 3200, term_months: 12, supersedes_policy_id: 1 }),
  // Unpaired add: the umbrella nothing preceded.
  policy({ id: 3, nickname: "RLI umbrella", carrier: "RLI", status: "replacing", term_premium: 600, term_months: 12 }),
  // Unpaired drop: cancelled outright, nothing took its place.
  policy({ id: 4, nickname: "old flood", carrier: "Wright", status: "cancelled", term_premium: 900, term_months: 12 }),
  // Neither side: a quote turned down. Kept because it records WHY.
  policy({ id: 5, nickname: "Homesite quote", carrier: "Homesite", status: "declined", term_premium: 100, term_months: 12 }),
];

test("programTotals sums each side and keeps a declined quote out of both", () => {
  const totals = programTotals(PROGRAM);
  assert.equal(totals.before.annual, 3300);      // 2400 replaced + 900 cancelled
  assert.equal(totals.before.count, 2);
  assert.equal(totals.after.annual, 3800);       // 3200 in_force + 600 replacing
  assert.equal(totals.after.count, 2);
  assert.equal(totals.delta.annual, 500);
  assert.equal(totals.delta.monthly, 41.67);
  assert.equal(totals.delta.unknown_count, 0);

  // The $100 declined quote is in neither total.
  assert.equal(totals.before.annual + totals.after.annual, 7100);
});

test("programTotals carries an unknown premium through to the delta", () => {
  const totals = programTotals([
    policy({ id: 1, status: "replaced", term_premium: 2400, term_months: 12 }),
    policy({ id: 2, status: "in_force", term_premium: 950, term_months: null, supersedes_policy_id: 1 }),
  ]);
  assert.equal(totals.after.unknown_count, 1);
  assert.equal(totals.after.annual, 0);          // nothing known to add …
  assert.equal(totals.delta.unknown_count, 1);   // … and the caller is told why
});

test("compareProgram pairs across supersedes_policy_id and keeps one-sided rows", () => {
  const rows = compareProgram(PROGRAM);
  assert.equal(rows.length, 3);

  const replaced = rows.find((r) => r.change === "replaced");
  assert.equal(replaced.before.id, 1);
  assert.equal(replaced.after.id, 2);
  assert.equal(replaced.annual_before, 2400);
  assert.equal(replaced.annual_after, 3200);
  assert.equal(replaced.annual_delta, 800);
  assert.equal(replaced.unknown, false);

  // The workbook's Cost Detail legitimately has rows on only one side.
  const added = rows.find((r) => r.change === "added");
  assert.equal(added.after.id, 3);
  assert.equal(added.before, null);
  assert.equal(added.annual_before, null);
  assert.equal(added.annual_delta, 600);

  const dropped = rows.find((r) => r.change === "dropped");
  assert.equal(dropped.before.id, 4);
  assert.equal(dropped.after, null);
  assert.equal(dropped.annual_delta, -900);

  assert.equal(rows.some((r) => r.before?.id === 5 || r.after?.id === 5), false);
});

test("compareProgram reports an unknown side rather than inventing a delta", () => {
  const [row] = compareProgram([
    policy({ id: 1, status: "replaced", term_premium: 2400, term_months: 12 }),
    policy({ id: 2, status: "in_force", term_premium: 950, term_months: null, supersedes_policy_id: 1 }),
  ]);
  assert.equal(row.change, "replaced");
  assert.equal(row.annual_after, null);
  assert.equal(row.annual_delta, null);          // not -2400: nothing vanished
  assert.equal(row.unknown, true);
});

test("an after policy whose predecessor is not in the before set is an add, not a silent drop", () => {
  // The pointer survives ON DELETE SET NULL and stale data; an unresolvable one
  // must not remove a real cost from the comparison.
  const rows = compareProgram([
    policy({ id: 9, status: "in_force", term_premium: 1200, term_months: 12, supersedes_policy_id: 404 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].change, "added");
  assert.equal(rows[0].annual_after, 1200);
});

// -- Renewals -----------------------------------------------------------------

test("every policy appears in the calendar, including the one with no term_end", () => {
  const calendar = renewalCalendar([
    policy({ id: 1, term_end: "2027-10-12" }),
    policy({ id: 2, term_end: "2027-03-05" }),        // Neptune flood, off-cycle
    policy({ id: 3, term_end: null, status: "in_force" }),  // Progressive coverage screen
  ], "2026-09-07");

  assert.equal(calendar.length, 3);
  // Soonest first, undated LAST — never sorted to the top by a null coerced to
  // epoch, which would bury the renewal that is actually imminent.
  assert.deepEqual(calendar.map((r) => r.policy_id), [2, 1, 3]);

  assert.deepEqual(calendar[0], {
    policy_id: 2, renewal_date: "2027-03-05", days_until: 179, term_known: true, status: "in_force",
  });

  const undated = calendar[2];
  assert.equal(undated.term_known, false);
  assert.equal(undated.renewal_date, null);
  assert.equal(undated.days_until, null);
  // The requirement in one assertion: it is present, so the UI can say "term
  // unknown — confirm with carrier" rather than showing no upcoming renewal.
  assert.notEqual(undated, undefined);

  // A DATE straight out of pg, not a pre-formatted string.
  const [fromPg] = renewalCalendar([policy({ id: 4, term_end: new Date(Date.UTC(2026, 8, 21)) })], "2026-09-07");
  assert.equal(fromPg.renewal_date, "2026-09-21");
  assert.equal(fromPg.days_until, 14);
});

test("renewalTiers fires by lead time, in ascending urgency", () => {
  const tiers = (daysUntil) => renewalTiers({ daysUntil, termKnown: true, status: "in_force" });
  assert.deepEqual(tiers(61), []);
  assert.deepEqual(tiers(60), ["renewal-60d"]);
  assert.deepEqual(tiers(15), ["renewal-60d"]);
  assert.deepEqual(tiers(14), ["renewal-60d", "renewal-14d"]);
  // Renewal day itself: both are due, and ins_alerts keeps the 60-day one from
  // being sent a second time.
  assert.deepEqual(tiers(0), ["renewal-60d", "renewal-14d"]);
  // Past due is a stale record, not a countdown.
  assert.deepEqual(tiers(-1), []);
  assert.deepEqual(tiers(-400), []);
});

test("renewalTiers returns exactly term-unknown for an undated policy", () => {
  // One tier, so ins_alerts' (policy_id, renewal_date, tier) caps it at one
  // message rather than one a day forever.
  assert.deepEqual(renewalTiers({ termKnown: false, status: "in_force" }), ["term-unknown"]);
  assert.deepEqual(renewalTiers({ policy: policy({ term_end: null }), status: "in_force" }), ["term-unknown"]);

  // The Number(null) trap alertTiers guards against: an undated policy must not
  // read as "renews today" and fire every tier.
  assert.deepEqual(renewalTiers({ daysUntil: null, termKnown: true, status: "in_force" }), []);
  assert.deepEqual(renewalTiers({ daysUntil: "", termKnown: true, status: "in_force" }), []);
});

test("a declined, replaced or cancelled policy never alerts", () => {
  for (const status of ["declined", "replaced", "cancelled"]) {
    assert.deepEqual(renewalTiers({ daysUntil: 3, termKnown: true, status }), [], status);
    // Not even the term-unknown tier: chasing a policy nobody holds is what
    // trains the mailbox to ignore this sender.
    assert.deepEqual(renewalTiers({ termKnown: false, status }), [], status);
  }
  assert.deepEqual(renewalTiers({ daysUntil: 3, termKnown: true, policy: policy({ status: "declined" }) }), []);
  // A quote, by contrast, does have a term worth watching.
  assert.deepEqual(renewalTiers({ daysUntil: 3, termKnown: true, status: "quoted" }), ["renewal-60d", "renewal-14d"]);
});

// -- Forms schedules ----------------------------------------------------------

test("a forms diff reports the add, the drop and the edition revision", () => {
  const prior = [
    { code: "HO-3RFL", edition: "09-16", title: "HOMEOWNERS SPECIAL FORM", disposition: "remains", page: 7 },
    // The URGENT finding: Ordinance or Law, in last year's schedule …
    { code: "HO-225FL", edition: "09-16", title: "ORDINANCE OR LAW 25%", disposition: "remains", page: 7 },
    { code: "HO-208FL", edition: "12-15", title: "WATER BACKUP OR SUMP PUMP OVERFLOW", disposition: "remains", page: 7 },
  ];
  const current = [
    { code: "ho-3rfl  ", edition: "09-16", title: "HOMEOWNERS SPECIAL FORM", disposition: "remains", page: 7 },
    { code: "HO-208FL", edition: "05-19", title: "WATER BACKUP OR SUMP PUMP OVERFLOW", disposition: "remains", page: 7 },
    { code: "HO-CGCC", edition: "08-16", title: "CATASTROPHIC GROUND COVER COLLAPSE", disposition: "added", page: 7 },
  ];

  const diff = diffFormsSchedules(prior, current);

  assert.deepEqual(diff.added.map((f) => f.code), ["HO-CGCC"]);
  // … and not in this one. Resolved r7, computed rather than concluded.
  assert.deepEqual(diff.dropped.map((f) => f.code), ["HO-225FL"]);
  // Case and trailing space are the same form, not a drop plus an add.
  assert.deepEqual(diff.retained.map((f) => f.code), ["ho-3rfl  ", "HO-208FL"]);

  // Still there, but not the wording anyone last read.
  assert.equal(diff.revised.length, 1);
  assert.equal(diff.revised[0].code, "HO-208FL");
  assert.equal(diff.revised[0].prior_edition, "12-15");
  assert.equal(diff.revised[0].current_edition, "05-19");
  // revised is a SUBSET of retained, never an alternative to it.
  assert.ok(diff.retained.some((f) => f.code === "HO-208FL"));
});

test("a forms diff handles a missing prior schedule and a duplicated code", () => {
  // With only one term in hand every form is an add and nothing is a drop,
  // which is the honest answer: the diff can flag a schedule but not a loss.
  const only = diffFormsSchedules([], [{ code: "HO-3RFL", edition: "09-16" }]);
  assert.deepEqual(only.added.map((f) => f.code), ["HO-3RFL"]);
  assert.deepEqual(only.dropped, []);
  assert.deepEqual(only.retained, []);

  assert.deepEqual(diffFormsSchedules(null, undefined), { added: [], dropped: [], retained: [], revised: [] });

  // A schedule that lists a form twice is one form, not a phantom add.
  const dupes = diffFormsSchedules(
    [{ code: "HO-125FL", edition: "09-16" }],
    [{ code: "HO-125FL", edition: "09-16" }, { code: "HO-125FL", edition: "09-16" }]
  );
  assert.equal(dupes.retained.length, 1);
  assert.deepEqual(dupes.added, []);
  assert.deepEqual(dupes.revised, []);
});
