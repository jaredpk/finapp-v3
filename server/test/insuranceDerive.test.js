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

  // `page: null` is the ordinary shape for a field nobody could cite, and
  // Number(null) is 0. A citation to page 0 is a citation to nothing, and every
  // finding in this feature is (document_id, page).
  assert.equal(cellPage(cell("USAA")), null);
  assert.equal(cellPage({ value: "USAA", state: "value" }), null);
  assert.equal(cellPage({ value: "USAA", state: "value", page: "" }), null);
  assert.equal(cellPage({ value: "USAA", state: "value", page: [] }), null);
  assert.equal(cellPage({ value: "USAA", state: "value", page: "6" }), 6);
});

test("a cell that states a value but carries none is malformed, and never wins", () => {
  // The same fall as an unrecognised state, for the same reason: `value` is a
  // claim that the page says something, and a null alongside it is a claim that
  // it says nothing. Read as `value` it would outrank the owner's column.
  assert.equal(cellState({ value: null, state: "value", page: 6 }), "unreadable");
  assert.equal(cellState({ state: "value", page: 6 }), "unreadable");
  assert.equal(cellValue({ value: null, state: "value" }), null);

  // 0 and "" are real readings of a page and are untouched by that.
  assert.equal(cellState(cell(0)), "value");
  assert.equal(cellValue(cell(0)), 0);
  assert.equal(cellState(cell("")), "value");

  // The failure it prevents: a cell asserting a blank must not blank the
  // carrier the owner typed.
  assert.deepEqual(
    resolveField("carrier", {
      policy: policy(),
      extraction: extraction({ carrier: { value: null, state: "value", page: 6 } }),
    }),
    { value: "USAA", state: "value", source: "policy", page: null }
  );
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

test("verified_on, notes and nickname are owner-only, so no extraction gets a turn", () => {
  // verified_on records that a PERSON checked, notes are the owner's own prose,
  // and nickname is what the household calls the policy — none of the three is
  // a fact a carrier prints, which is the reasoning resolvePolicyView already
  // applies to status. A cell claiming one of them must not outrank the column.
  const payload = {
    verified_on: cell("2020-01-01", "value", 1),
    notes: cell("Thank you for insuring with USAA.", "value", 1),
    nickname: cell("USAA CASUALTY INSURANCE COMPANY", "value", 1),
  };
  const owned = policy({ verified_on: "2026-09-01", notes: "escrowed; call Chase before renewal" });

  for (const [field, expected] of [
    ["verified_on", "2026-09-01"],
    ["notes", "escrowed; call Chase before renewal"],
    ["nickname", "USAA FL homeowners"],
  ]) {
    assert.deepEqual(
      resolveField(field, { policy: owned, extraction: extraction(payload) }),
      { value: expected, state: "value", source: "policy", page: null },
      field
    );
  }

  // With the column empty too the answer is "nobody has filled this in", never
  // a document state: no document was ever asked the question.
  assert.deepEqual(
    resolveField("notes", { policy: policy({ notes: null }), extraction: extraction(payload) }),
    { value: null, state: CELL_MISSING, source: "none", page: null }
  );

  // The owner still moves them by override, which is the only way they move.
  assert.equal(resolveField("verified_on", {
    policy: owned,
    overrides: [{ field_path: "verified_on", value: "2026-09-07" }],
    extraction: extraction(payload),
  }).value, "2026-09-07");

  const view = resolvePolicyView({ policy: owned, extractions: [extraction(payload)] });
  assert.equal(view.verified_on, "2026-09-01");
  assert.equal(view.notes, "escrowed; call Chase before renewal");
  assert.equal(view.nickname, "USAA FL homeowners");
  assert.equal(view.fields.notes.source, "policy");
});

test("a dotted path resolves into a coverage line, from an extraction and from an override", () => {
  // Why getPath exists: an override pins one coverage's limit without the whole
  // schedule being re-entered, and the coverage lines are bare scalars rather
  // than cells.
  const payload = {
    coverages: [
      { code: "A", label: "DWELLING PROTECTION", limit_value: 554000, page: 6 },
      { code: "B", label: "OTHER STRUCTURES PROTECTION", limit_value: 55400, page: 6 },
    ],
  };

  assert.deepEqual(
    resolveField("coverages.0.limit_value", { policy: policy(), extraction: extraction(payload) }),
    { value: 554000, state: "value", source: "extraction", page: null }
  );
  assert.equal(
    resolveField("coverages.1.limit_value", { policy: policy(), extraction: extraction(payload) }).value,
    55400
  );

  assert.deepEqual(
    resolveField("coverages.0.limit_value", {
      policy: policy(),
      overrides: [{ field_path: "coverages.0.limit_value", value: 600000, note: "endorsed mid-term" }],
      extraction: extraction(payload),
    }),
    { value: 600000, state: "value", source: "override", page: null }
  );

  // A coverage line is not a column on ins_policies, so a path nothing answers
  // is `missing` rather than a value borrowed from the spine.
  assert.deepEqual(
    resolveField("coverages.9.limit_value", { policy: policy(), extraction: extraction(payload) }),
    { value: null, state: CELL_MISSING, source: "none", page: null }
  );
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

test("across documents the newest extraction wins when both state a value", () => {
  // The direction nothing asserted before, and the hole HIGH 1 fell through:
  // two documents that BOTH state the same fields, differently. This year's
  // declarations page has to beat last year's, or the merge quietly restores a
  // carrier, a policy number and a term that were superseded.
  //
  // extracted_at is a JS Date here BECAUSE THAT IS WHAT PG RETURNS for a
  // TIMESTAMPTZ, and String(new Date(...)) is "Tue Sep 01 2026 ..." — weekday
  // first. Sorted as strings, "Tue" beats "Sat" and the September 1 document
  // wins over the September 5 one.
  const stale = extraction(
    { carrier: cell("STALE"), policy_number: cell("HO-OLD"), term_end: cell("2026-10-12") },
    { document_id: 1, extracted_at: new Date(Date.UTC(2026, 8, 1)) }   // a Tuesday
  );
  const current = extraction(
    { carrier: cell("CURRENT"), policy_number: cell("HO-NEW"), term_end: cell("2027-10-12") },
    { document_id: 2, extracted_at: new Date(Date.UTC(2026, 8, 5)) }   // a Saturday
  );

  // Both input orders, so the answer is the sort's and not the array's.
  for (const rows of [[stale, current], [current, stale]]) {
    const merged = mergeExtractions(rows);
    assert.equal(cellValue(merged.carrier), "CURRENT");
    assert.equal(cellValue(merged.policy_number), "HO-NEW");
    assert.equal(cellValue(merged.term_end), "2027-10-12");
  }

  // The other shape a driver hands back: a timestamp string with a space and a
  // two-digit offset, which is not ISO and must still order.
  const pgStrings = mergeExtractions([
    extraction({ carrier: cell("STALE") }, { document_id: 1, extracted_at: "2026-09-01 00:00:00+00" }),
    extraction({ carrier: cell("CURRENT") }, { document_id: 2, extracted_at: "2026-09-05 12:30:00+00" }),
  ]);
  assert.equal(cellValue(pgStrings.carrier), "CURRENT");

  // A Date and the ISO string of the same instant are the same instant, so the
  // tie-break falls through to the document id (insertion order) as documented.
  const tied = mergeExtractions([
    extraction({ carrier: cell("EARLIER ROW") }, { document_id: 7, extracted_at: "2026-09-05T00:00:00.000Z" }),
    extraction({ carrier: cell("LATER ROW") }, { document_id: 8, extracted_at: new Date(Date.UTC(2026, 8, 5)) }),
  ]);
  assert.equal(cellValue(tied.carrier), "LATER ROW");

  // A row nobody can date cannot claim to be the newest reading — even with the
  // higher document id.
  const undated = mergeExtractions([
    extraction({ carrier: cell("NO TIMESTAMP") }, { document_id: 9, extracted_at: null }),
    extraction({ carrier: cell("DATED") }, { document_id: 1, extracted_at: new Date(Date.UTC(2026, 0, 2)) }),
  ]);
  assert.equal(cellValue(undated.carrier), "DATED");
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
  assert.equal(view.mailing_address, "HERRIMAN UT 84096");
  // Read from different pages, which is the whole reason they are two fields:
  // page 1 is where the mail goes and page 6 is what is insured.
  assert.equal(view.fields.risk_address.page, 6);
  assert.equal(view.fields.mailing_address.page, 1);
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
  // A $1,900 six-month auto premium reported as $1,900/yr understates the
  // program by nearly two thousand dollars while looking entirely plausible,
  // which is why an unknown term is an answer here and not a default of 12.
  for (const termMonths of [null, undefined, "", "unknown", NaN, 0, -6]) {
    const result = annualizePremium({ termPremium: 1900, termMonths });
    assert.equal(result.annual, null, `termMonths ${String(termMonths)} must not annualize`);
    assert.equal(result.state, "term-months-unknown");
  }
  assert.deepEqual(annualizePremium({ termPremium: null, termMonths: 6 }), { annual: null, state: "premium-unknown" });
});

test("a blank premium is unknown, never a confident $0.00 a year", () => {
  // Number(""), Number(" "), Number("$") and Number([]) are all 0 and all pass
  // a finite check, so a premium nobody read would annualize to a stated zero —
  // the one answer this module is not allowed to give, and indistinguishable
  // from a policy that genuinely costs nothing.
  for (const termPremium of ["", "   ", "$", "-", "N/A", "unknown", [], null, undefined, NaN]) {
    const result = annualizePremium({ termPremium, termMonths: 12 });
    assert.equal(result.annual, null, `termPremium ${JSON.stringify(termPremium)} must not annualize`);
    assert.equal(result.state, "premium-unknown");
  }

  // A zero the document actually prints is a different claim, and it is kept:
  // 0 is a legitimate premium, which is why this cannot be filtered downstream
  // the way an impossible term length is.
  assert.deepEqual(annualizePremium({ termPremium: 0, termMonths: 12 }), { annual: 0, state: "value" });
  assert.deepEqual(annualizePremium({ termPremium: "$0.00", termMonths: 6 }), { annual: 0, state: "value" });

  // Both ways a blank reaches here. An extraction cell that carries "" …
  const extracted = resolvePolicyView({
    policy: policy({ term_premium: null }),
    extractions: [extraction({ term_premium: cell("", "value", 6), term_months: cell(12, "value", 6) })],
  });
  assert.equal(extracted.annual_premium, null);
  assert.equal(extracted.annual_premium_state, "premium-unknown");

  // … and an owner override of "", which ins_overrides stores as a value
  // distinct from null and from 0.
  const overridden = resolvePolicyView({
    policy: policy({ term_premium: 3200, term_months: 12 }),
    overrides: [{ field_path: "term_premium", value: "" }],
  });
  assert.equal(overridden.annual_premium, null);
  assert.equal(overridden.annual_premium_state, "premium-unknown");

  // And the consequence the rollup has to show: counted, not summed as zero.
  const [group] = rollup([policy({ term_premium: "  ", term_months: 12 })], (p) => p.carrier);
  assert.equal(group.annual, 0);
  assert.equal(group.unknown_count, 1);
  assert.equal(group.count, 1);
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
  assert.equal(usaa.count, 2);
  assert.equal(usaa.policies.length, 2);

  const progressive = rows.find((r) => r.key === "Progressive");
  assert.equal(progressive.annual, 1400);        // the six-month term, doubled …
  assert.equal(progressive.unknown_count, 1);    // … and the undated one COUNTED, not summed as 0
  // "2 policies, one of them unpriced" is the readable row; unknown_count on
  // its own is not, which is why sumAnnual's count survives into the rollup.
  assert.equal(progressive.count, 2);
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

  // The $100 declined quote is in neither total: removing it from the program
  // changes nothing at all, which is the only assertion that says so.
  assert.deepEqual(programTotals(PROGRAM.filter((p) => p.status !== "declined")), totals);
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

test("one predecessor can only be claimed once, however many replacements point at it", () => {
  // A home policy rewritten as two, or a pointer copied along with the row.
  // Pairing both claimants would subtract the old premium TWICE and report a
  // saving that does not exist.
  const rows = compareProgram([
    policy({ id: 1, nickname: "old home", status: "replaced", term_premium: 2400, term_months: 12 }),
    policy({ id: 2, nickname: "new home", status: "in_force", term_premium: 1600, term_months: 12, supersedes_policy_id: 1 }),
    policy({ id: 3, nickname: "new flood", status: "in_force", term_premium: 900, term_months: 12, supersedes_policy_id: 1 }),
  ]);
  assert.equal(rows.length, 2);

  const paired = rows.find((r) => r.after?.id === 2);
  assert.equal(paired.change, "replaced");
  assert.equal(paired.before.id, 1);
  assert.equal(paired.annual_delta, -800);

  // The second claimant is an ADD, not a second pairing …
  const second = rows.find((r) => r.after?.id === 3);
  assert.equal(second.change, "added");
  assert.equal(second.before, null);
  assert.equal(second.annual_before, null);
  assert.equal(second.annual_delta, 900);

  // … so the 2400 is subtracted exactly once across the whole comparison, and
  // the row-by-row deltas still add up to what programTotals says.
  assert.equal(rows.filter((r) => r.before?.id === 1).length, 1);
  assert.equal(rows.reduce((sum, r) => sum + r.annual_delta, 0), 100);
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

  // The requirement in one assertion: the undated policy is present, whole, and
  // says which parts it cannot answer — so the UI can render "term unknown —
  // confirm with carrier" instead of showing no upcoming renewal, which is how
  // the two Progressive policies would go a year without anyone confirming.
  assert.deepEqual(calendar[2], {
    policy_id: 3, renewal_date: null, days_until: null, term_known: false, status: "in_force",
  });

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
  // Past due is a stale record, not a countdown — a tier of its own rather than
  // a lead time (see the term-stale test below).
  assert.deepEqual(tiers(-1), ["term-stale"]);
  assert.deepEqual(tiers(-400), ["term-stale"]);
});

test("a term that has already passed alerts as stale rather than going quiet", () => {
  // Where this DIVERGES from alertTiers, and why it has to. resolvePeriod
  // recomputes a benefit's period on every read, so period_end is never durably
  // in the past; ins_policies.term_end is an owner-maintained column that
  // nothing recomputes, so a date that has gone sits there indefinitely while
  // the owner goes on believing they are covered. That is the worse lapse state
  // of the two — an undated policy at least gets term-unknown — and Open Items
  // r8 prices it: "a lapse breaks the RLI Basic Policy condition".
  assert.deepEqual(renewalTiers({ daysUntil: -1, termKnown: true, status: "in_force" }), ["term-stale"]);
  assert.deepEqual(renewalTiers({ daysUntil: -365, termKnown: true, status: "quoted" }), ["term-stale"]);

  // One tier, so ins_alerts (policy_id, renewal_date, tier) caps it at one
  // message per stale date rather than one a day forever.
  assert.equal(renewalTiers({ daysUntil: -5, termKnown: true, status: "in_force" }).length, 1);

  // A policy nobody holds any more is not news: the never-alert statuses stay
  // silent even here.
  for (const status of ["declined", "replaced", "cancelled"]) {
    assert.deepEqual(renewalTiers({ daysUntil: -5, termKnown: true, status }), [], status);
  }

  // Not to be confused with either neighbour: an undated policy is still
  // term-unknown, and renewal day itself is still a lead-time reminder.
  assert.deepEqual(renewalTiers({ termKnown: false, status: "in_force" }), ["term-unknown"]);
  assert.deepEqual(renewalTiers({ daysUntil: 0, termKnown: true, status: "in_force" }), ["renewal-60d", "renewal-14d"]);
  // And a countdown that cannot be computed at all is still silence, not stale.
  assert.deepEqual(renewalTiers({ daysUntil: null, termKnown: true, status: "in_force" }), []);

  // End to end from the calendar entry, which is how the cron will call it.
  const [entry] = renewalCalendar([policy({ id: 1, term_end: "2026-08-01" })], "2026-09-07");
  assert.equal(entry.days_until, -37);
  assert.deepEqual(
    renewalTiers({ daysUntil: entry.days_until, termKnown: entry.term_known, status: entry.status }),
    ["term-stale"]
  );
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

  assert.deepEqual(diffFormsSchedules(null, undefined),
    { added: [], dropped: [], retained: [], revised: [], codeless: [] });

  // A schedule that lists a form twice is one form, not a phantom add — and the
  // two printings DIFFER, so which one is carried is visible: the FIRST. A diff
  // that kept the last would report the reprint's 05-19 as a revision of an
  // edition that never changed.
  const dupes = diffFormsSchedules(
    [{ code: "HO-125FL", edition: "09-16", title: "HOME PROTECTOR", page: 7 }],
    [
      { code: "HO-125FL", edition: "09-16", title: "HOME PROTECTOR", page: 7 },
      { code: "ho-125fl", edition: "05-19", title: "HOME PROTECTOR (REPRINT)", page: 9 },
    ]
  );
  assert.equal(dupes.retained.length, 1);
  assert.equal(dupes.retained[0].page, 7);
  assert.equal(dupes.retained[0].edition, "09-16");
  assert.deepEqual(dupes.added, []);
  assert.deepEqual(dupes.revised, []);
});

test("a schedule entry with no code is surfaced, not dropped", () => {
  // The recall guarantee is over the entries that carry a code, because the
  // diff is keyed on the code. An entry without one lands in none of
  // added/dropped/retained/revised, and returning four empty buckets for it
  // would be a confident "nothing changed" over a line nobody could read.
  const diff = diffFormsSchedules(
    [{ code: "HO-3RFL", edition: "09-16" }, { code: "  ", edition: "09-16", title: "UNNAMED PRIOR ENDORSEMENT" }],
    [{ code: "HO-3RFL", edition: "09-16" }, { edition: "05-16", title: "BUILDING CODE CREDIT" }]
  );
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.dropped, []);
  assert.equal(diff.retained.length, 1);

  assert.equal(diff.codeless.length, 2);
  // Which side it came from changes what the gap means, so it travels with it.
  assert.deepEqual(diff.codeless.map((c) => c.side), ["prior", "current"]);
  assert.equal(diff.codeless[0].form.title, "UNNAMED PRIOR ENDORSEMENT");
  assert.equal(diff.codeless[1].form.title, "BUILDING CODE CREDIT");
});

test("an edition that differs only in spacing or case is not a revision", () => {
  // formKey normalises the code because carriers print codes inconsistently.
  // The same carriers print the edition, and a false `revised` reads as "the
  // wording that defines this coverage changed" — which sends someone to
  // re-read a form that never moved, on the path whose whole value is that its
  // findings are arithmetic rather than judgment.
  const same = diffFormsSchedules(
    [{ code: "HO-208FL", edition: "09-16" }],
    [{ code: "HO-208FL", edition: " 09-16 " }]
  );
  assert.deepEqual(same.revised, []);
  assert.equal(same.retained.length, 1);

  // A missing edition on both sides is not a revision either.
  assert.deepEqual(diffFormsSchedules([{ code: "219" }], [{ code: "219", edition: null }]).revised, []);

  // A real edition change still reports, and reports the editions AS PRINTED —
  // the normalised key is for comparing, not for showing.
  const changed = diffFormsSchedules(
    [{ code: "HO-208FL", edition: "12-15" }],
    [{ code: "HO-208FL", edition: " 05-19" }]
  );
  assert.equal(changed.revised.length, 1);
  assert.equal(changed.revised[0].prior_edition, "12-15");
  assert.equal(changed.revised[0].current_edition, " 05-19");
});
