import test from "node:test";
import assert from "node:assert/strict";
import { buildDigestEmail } from "../alertEmail.js";

// The I/O-free half of alert delivery: what the digest email says. No pg, no
// Gmail client, no clock — `today` is injected, the same way geminiUsage.js
// takes its clock, so every assertion here is stable.
//
// The delivery half (sendAlert / sendTestEmail) is deliberately untested: it is
// two DB calls and one Gmail call, and a test with a faked client would assert
// the call I just wrote rather than whether Gmail accepts it. The RFC 2047
// header encoding those messages go out with lives in gmail.js's sendMail for
// the same reason — it can only be exercised against a real client.
//
// The item shape below — { benefit, card, amountRemaining, unit, periodEnds,
// daysLeft, tier } — is what phase 2's evaluation emits. It is fixed here
// on purpose so the composition and the evaluation can be built against the
// same contract. `unit` is optional and means dollars when absent.

const AMEX = {
  benefit: "Uber Cash",
  card: "Amex Platinum",
  amountRemaining: 15,
  periodEnds: "2026-08-31",
  daysLeft: 8,
  tier: "monthly-7",
};

const VENTURE = {
  benefit: "Travel portal credit",
  card: "Venture X",
  amountRemaining: 300,
  periodEnds: "2026-10-04",
  daysLeft: 42,
  tier: "annual-45",
};

// ── Nothing to say ────────────────────────────────────────────────────────────

test("an empty evaluation composes no email at all", () => {
  // Silence is the point: a daily "0 credits expiring" email trains the mailbox
  // to ignore this sender, and then the one that matters gets ignored too.
  assert.equal(buildDigestEmail({ items: [], today: "2026-08-23" }), null);
  assert.equal(buildDigestEmail({ items: null, today: "2026-08-23" }), null);
  assert.equal(buildDigestEmail({ today: "2026-08-23" }), null);
  assert.equal(buildDigestEmail(), null);
  // A list of nothing but holes is still an empty list.
  assert.equal(buildDigestEmail({ items: [null, undefined], today: "2026-08-23" }), null);
});

// ── One item ──────────────────────────────────────────────────────────────────

test("a single item names the benefit, the amount and the deadline", () => {
  const email = buildDigestEmail({ items: [AMEX], today: "2026-08-23" });
  assert.equal(email.subject, "Card benefit expiring: Uber Cash ($15.00) — in 8 days");

  // The card is what tells the reader which wallet to reach for, so it has to
  // survive into both bodies, not just the HTML one.
  assert.match(email.text, /Amex Platinum/);
  assert.match(email.text, /Uber Cash: \$15\.00 left, expires in 8 days \(period ends 2026-08-31\)/);
  assert.match(email.text, /as of 2026-08-23/);
  assert.match(email.html, /Amex Platinum/);
  assert.match(email.html, /Uber Cash/);
  assert.match(email.html, /\$15\.00/);

  // One item has no total to report — the amount is already on the line above.
  assert.doesNotMatch(email.text, /Total unused/);

  // Inline styles only; a <style> block would be stripped by Gmail.
  assert.doesNotMatch(email.html, /<style/i);
  assert.match(email.html, /style="/);
});

test("day counts read as English, and an already-expired item never reads as negative", () => {
  const oneDay = buildDigestEmail({ items: [{ ...AMEX, daysLeft: 1 }], today: "2026-08-23" });
  assert.match(oneDay.subject, /in 1 day\b/);
  assert.doesNotMatch(oneDay.subject, /in 1 days/);

  // "-2 days" looks like a bug and gets ignored, which is the one outcome an
  // expiry nudge cannot afford.
  const overdue = buildDigestEmail({ items: [{ ...AMEX, daysLeft: -2 }], today: "2026-08-23" });
  assert.match(overdue.subject, /today/);
  assert.doesNotMatch(overdue.subject, /-2/);
});

// ── Several items ─────────────────────────────────────────────────────────────

test("multiple items group under their card, in the order the caller supplied", () => {
  const second = { ...AMEX, benefit: "Digital entertainment credit", amountRemaining: 20, daysLeft: 8 };
  const email = buildDigestEmail({ items: [AMEX, second, VENTURE], today: "2026-08-23" });

  // Each card heading appears exactly once, however many of its benefits are due.
  assert.equal((email.text.match(/^Amex Platinum$/gm) || []).length, 1);
  assert.equal((email.text.match(/^Venture X$/gm) || []).length, 1);
  assert.equal((email.html.match(/Amex Platinum/g) || []).length, 1);

  // Both Amex benefits sit under the Amex heading, above the Venture X one.
  const amexAt = email.text.indexOf("Amex Platinum");
  const ventureAt = email.text.indexOf("Venture X");
  assert.ok(amexAt < email.text.indexOf("Uber Cash"));
  assert.ok(email.text.indexOf("Digital entertainment credit") < ventureAt);
  assert.ok(ventureAt < email.text.indexOf("Travel portal credit"));
});

test("the subject counts the items, totals what is unused and leads with the nearest deadline", () => {
  const email = buildDigestEmail({ items: [VENTURE, AMEX], today: "2026-08-23" });
  // $300 + $15, and the soonest deadline is the Amex one even though it is
  // listed second — the subject reports urgency, not list order.
  assert.equal(email.subject, "2 card benefits expiring — $315.00 unused, soonest in 8 days");
  assert.match(email.text, /Total unused: \$315\.00/);
  assert.match(email.html, /Total unused: \$315\.00/);
});

// ── Units ─────────────────────────────────────────────────────────────────────

test("a benefit counted in visits is not reported in dollars", () => {
  // "$3.00 remaining" for three lounge visits is not a rounding problem, it is
  // the wrong sentence — and the whole point of an expiry nudge is that the
  // reader can act on it.
  const email = buildDigestEmail({
    items: [{ ...AMEX, benefit: "Sky Club visits", amountRemaining: 3, unit: "visits" }],
    today: "2026-08-23",
  });
  assert.equal(email.subject, "Card benefit expiring: Sky Club visits (3 visits) — in 8 days");
  assert.match(email.text, /Sky Club visits: 3 visits left/);
  assert.match(email.html, /3 visits left/);
  assert.doesNotMatch(email.text, /\$3\.00/);

  // One visit is singular; a plain count carries no noun at all.
  assert.match(
    buildDigestEmail({ items: [{ ...AMEX, amountRemaining: 1, unit: "visits" }], today: "2026-08-23" }).subject,
    /\(1 visit\)/
  );
  assert.match(
    buildDigestEmail({ items: [{ ...AMEX, amountRemaining: 4, unit: "count" }], today: "2026-08-23" }).subject,
    /\(4\)/
  );
});

test("points are points, with a separator and no dollar sign", () => {
  const email = buildDigestEmail({
    items: [{ ...VENTURE, benefit: "Transfer bonus", amountRemaining: 10000, unit: "points" }],
    today: "2026-08-23",
  });
  assert.match(email.subject, /\(10,000 pts\)/);
  assert.match(email.text, /10,000 pts left/);
  assert.doesNotMatch(email.text, /\$10,000/);
});

test("only dollars are added into the headline total, and it disappears when there are none", () => {
  // $300 of credit plus 13 lounge visits is not $313 of anything, so the total
  // covers the money items and says nothing about the rest.
  const mixed = buildDigestEmail({
    items: [VENTURE, { ...AMEX, benefit: "Sky Club visits", amountRemaining: 13, unit: "visits" }],
    today: "2026-08-23",
  });
  assert.equal(mixed.subject, "2 card benefits expiring — $300.00 unused, soonest in 8 days");
  assert.match(mixed.text, /Total unused: \$300\.00/);
  assert.match(mixed.text, /13 visits left/);

  const noMoney = buildDigestEmail({
    items: [
      { ...VENTURE, amountRemaining: 2, unit: "visits" },
      { ...AMEX, amountRemaining: 5000, unit: "points" },
    ],
    today: "2026-08-23",
  });
  assert.equal(noMoney.subject, "2 card benefits expiring, soonest in 8 days");
  assert.doesNotMatch(noMoney.text, /Total unused/);
  assert.doesNotMatch(noMoney.html, /Total unused/);
});

test("an item with no unit at all is still money, exactly as before", () => {
  const email = buildDigestEmail({ items: [AMEX, { ...AMEX, unit: undefined }], today: "2026-08-23" });
  assert.match(email.subject, /\$30\.00 unused/);
});

test("amounts over a thousand carry a separator, and cents are never dropped", () => {
  const email = buildDigestEmail({
    items: [{ ...VENTURE, amountRemaining: 1234.5 }, { ...AMEX, amountRemaining: 0.5 }],
    today: "2026-08-23",
  });
  assert.match(email.subject, /\$1,235\.00 unused/);
  assert.match(email.text, /\$1,234\.50 left/);
  assert.match(email.text, /\$0\.50 left/);
});

// ── Text that is not ASCII, and text that is not text ──────────────────────────

test("a non-ASCII benefit name reaches the subject as intact UTF-8", () => {
  // Catalog data is owner-typed and will contain accents and currency symbols.
  // What matters here is that nothing lossy happens on the way to the subject
  // line — the RFC 2047 encoded-word wrapping that carries these bytes through
  // an SMTP header is applied by gmail.js's sendMail, not here.
  const email = buildDigestEmail({
    items: [{ ...AMEX, benefit: "Café & résumé crédit — €50" }],
    today: "2026-08-23",
  });
  assert.match(email.subject, /Café & résumé crédit — €50/);
  assert.doesNotMatch(email.subject, /�/); // no replacement characters
  // Round-trips through UTF-8 unchanged, which is what the encoded-word needs.
  assert.equal(
    Buffer.from(Buffer.from(email.subject, "utf8").toString("base64"), "base64").toString("utf8"),
    email.subject
  );
});

test("a benefit name containing markup is escaped in the HTML body", () => {
  // Benefit and card names are owner-entered catalog data, not constants, so
  // they are treated as untrusted text. The plain-text part is left alone —
  // escaping it would show the reader literal &amp;.
  const email = buildDigestEmail({
    items: [{ ...AMEX, benefit: "<b>Dining</b> & drinks", card: "Card <script>" }],
    today: "2026-08-23",
  });
  assert.match(email.html, /&lt;b&gt;Dining&lt;\/b&gt; &amp; drinks/);
  assert.match(email.html, /Card &lt;script&gt;/);
  assert.doesNotMatch(email.html, /<b>Dining<\/b>/);
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.text, /<b>Dining<\/b> & drinks/);
});
