// Outbound alert delivery for card-benefit tracking (Brief 05, phase 1).
//
// Split the same way limits.js and geminiUsage.js are: the first half is the
// email composition and is deliberately I/O-free — no pg, no Google client, no
// clock of its own — so the thing most likely to be wrong (what the message
// actually says) is unit-testable without a database or a mailbox
// (test/alertEmail.test.js). The second half is delivery, which does read and
// write the DB and does talk to Gmail.
//
// The channel itself is Gmail-as-the-owner (gmail.js sendMail): the recipient
// is resolved from the connected profile and cannot be configured, so nothing
// composed here can be delivered to a third party.
import { sendMail } from "./gmail.js";
import { wasAlertSent, recordAlertSent } from "./db.js";

// ── Composition (pure) ────────────────────────────────────────────────────────

function money(amount) {
  const value = Number(amount) || 0;
  return `$${value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// "in 7 days" / "in 1 day" / "today". Anything past due reads as today rather
// than as a negative count — an alert that says "-2 days" looks like a bug and
// gets ignored, which is the one outcome an expiry nudge cannot afford.
function daysPhrase(daysLeft) {
  const n = Number(daysLeft);
  if (!Number.isFinite(n) || n <= 0) return "today";
  return n === 1 ? "in 1 day" : `in ${n} days`;
}

function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Every value that reaches the HTML goes through this. Benefit and card names
// are owner-entered catalog data (phase 2), not constants, so they are treated
// as untrusted text.
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Groups items by card, preserving first-seen card order, and within a card the
// order the caller supplied. Sorting is the caller's business: phase 2 decides
// what "most urgent" means, and this function must not silently reorder a list
// that was already ordered on purpose.
function groupByCard(items) {
  const groups = new Map();
  for (const item of items) {
    const card = item.card || "Card";
    if (!groups.has(card)) groups.set(card, []);
    groups.get(card).push(item);
  }
  return [...groups.entries()].map(([card, benefits]) => ({ card, benefits }));
}

// Composes the digest. `items` are
// { benefit, card, amountRemaining, periodEnds, daysLeft, tier } — the shape
// phase 2's evaluation will emit.
//
// Returns null when there is nothing to say. Silence is the correct output for
// an empty list: a daily "you have 0 expiring credits" email is how a mailbox
// learns to ignore this sender, and the caller (sendAlert) never gets invoked.
export function buildDigestEmail({ items, today } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return null;

  const asOf = formatDate(today);
  const total = list.reduce((sum, item) => sum + (Number(item.amountRemaining) || 0), 0);
  // Number(undefined) is NaN, and one NaN poisons a Math.min chain — so a
  // missing daysLeft is skipped rather than allowed to swallow the real minimum.
  const soonest = list.reduce((min, item) => {
    const days = Number(item.daysLeft);
    return Number.isFinite(days) ? Math.min(min, days) : min;
  }, Infinity);

  const subject = list.length === 1
    ? `Card benefit expiring: ${list[0].benefit} (${money(list[0].amountRemaining)}) — ${daysPhrase(list[0].daysLeft)}`
    : `${list.length} card benefits expiring — ${money(total)} unused` +
      (Number.isFinite(soonest) ? `, soonest ${daysPhrase(soonest)}` : "");

  const groups = groupByCard(list);

  const textLines = [asOf ? `Unused card benefits as of ${asOf}:` : "Unused card benefits:", ""];
  for (const { card, benefits } of groups) {
    textLines.push(card);
    for (const b of benefits) {
      const ends = formatDate(b.periodEnds);
      textLines.push(
        `  - ${b.benefit}: ${money(b.amountRemaining)} left, expires ${daysPhrase(b.daysLeft)}` +
        (ends ? ` (period ends ${ends})` : "")
      );
    }
    textLines.push("");
  }
  if (list.length > 1) textLines.push(`Total unused: ${money(total)}`, "");
  textLines.push("Sent by FinApp.");
  const text = textLines.join("\n");

  // Inline styles only, and no <style> block: Gmail strips stylesheets and most
  // other clients are worse. Plain tables/divs, nothing clever.
  const htmlGroups = groups.map(({ card, benefits }) => {
    const rows = benefits.map((b) => {
      const ends = formatDate(b.periodEnds);
      return `<li style="margin:0 0 8px 0;">
        <strong>${escapeHtml(b.benefit)}</strong> — ${escapeHtml(money(b.amountRemaining))} left,
        expires ${escapeHtml(daysPhrase(b.daysLeft))}${ends ? ` <span style="color:#6b7280;">(period ends ${escapeHtml(ends)})</span>` : ""}
      </li>`;
    }).join("\n");
    return `<h3 style="font-size:15px;margin:20px 0 8px 0;color:#111827;">${escapeHtml(card)}</h3>
      <ul style="margin:0;padding-left:18px;font-size:14px;color:#374151;">
${rows}
      </ul>`;
  }).join("\n");

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;color:#111827;">
  <p style="font-size:14px;color:#6b7280;margin:0 0 4px 0;">${asOf ? `Unused card benefits as of ${escapeHtml(asOf)}` : "Unused card benefits"}</p>
${htmlGroups}
${list.length > 1 ? `  <p style="font-size:14px;margin:20px 0 0 0;"><strong>Total unused: ${escapeHtml(money(total))}</strong></p>` : ""}
  <p style="font-size:12px;color:#9ca3af;margin:24px 0 0 0;">Sent by FinApp.</p>
</div>`;

  return { subject, text, html };
}

// ── Delivery (I/O) ────────────────────────────────────────────────────────────

// Sends once per alert_key, ever. The send is recorded only AFTER Gmail has
// accepted the message, so a failed send leaves no row and the next scheduled
// run retries it — the opposite order would turn one transient Gmail error into
// a permanently skipped alert.
export async function sendAlert({ alertKey, kind, subject, text, html }) {
  if (!alertKey) throw new Error("sendAlert requires an alertKey");
  if (await wasAlertSent(alertKey)) return { sent: false, reason: "already-sent" };

  const result = await sendMail({ subject, text, html });
  await recordAlertSent(alertKey, kind, subject);
  return { sent: true, messageId: result.id };
}

// Proves the whole channel end to end from Settings. Deliberately NOT routed
// through alert_log: a test that can only be run once is not a test.
export async function sendTestEmail() {
  const stamp = new Date().toISOString();
  const subject = "FinApp alerting is working";
  const text = `FinApp sent this at ${stamp} to confirm the Gmail send scope is granted and working.\n\nNothing else to do — card-benefit alerts will arrive the same way.\n`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;color:#111827;">
  <p style="font-size:14px;margin:0 0 12px 0;">FinApp sent this at <code>${escapeHtml(stamp)}</code> to confirm the Gmail send scope is granted and working.</p>
  <p style="font-size:14px;color:#6b7280;margin:0;">Nothing else to do — card-benefit alerts will arrive the same way.</p>
</div>`;
  const result = await sendMail({ subject, text, html });
  return { sent: true, messageId: result.id, sentAt: stamp };
}
