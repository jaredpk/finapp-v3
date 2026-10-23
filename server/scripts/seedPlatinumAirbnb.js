// One-off, idempotent: brings the owner's Amex Platinum catalog in line with the
// new Airbnb benefits.
//
//   node scripts/seedPlatinumAirbnb.js [--dry-run]
//
// Safe to re-run: every step looks before it writes. --dry-run reads the
// catalog and prints what it WOULD do, writing nothing.
import { pathToFileURL } from "node:url";

const OLD_LODGING_NAME = "Semi-Annual Hotel Credit";
const LODGING_NAME = "Lodging Credit";
const EXPERIENCES_NAME = "Airbnb Experiences Credit";
const VERIFIED_ON = "2026-10-23";

const LODGING_VALUES = {
  name: LODGING_NAME,
  amount_limit: 300,
  period_unit: "half",
  period_count: 1,
  period_basis: "calendar",
  verified_on: VERIFIED_ON,
  notes:
    "Prepaid Fine Hotels + Resorts, The Hotel Collection and (new) Airbnb Luxe bookings via AmexTravel.com / Amex Travel App. " +
    "Hotel Collection and Airbnb Luxe need a 2-night minimum; Fine Hotels + Resorts needs 2 nights from Jan 1, 2027.",
};

const EXPERIENCES_VALUES = {
  name: EXPERIENCES_NAME,
  amount_limit: 250,
  period_unit: "year",
  period_count: 1,
  period_basis: "calendar",
  unit: "usd",
  carryover: false,
  verified_on: VERIFIED_ON,
  notes:
    "Unlocks after a prepaid Airbnb Luxe stay booked via Amex Travel in the same calendar year; " +
    "then up to $250 in statement credits for the rest of that year on Airbnb Experiences bought directly with Airbnb.",
};

const RULE_VALUES = { merchant_regex: "AIRBNB", direction: "charge" };

export function findPlatinumCard(catalog) {
  const matches = catalog.filter(
    (c) =>
      /^\s*american express\s*$/i.test(c.issuer || "") &&
      /platinum/i.test(`${c.product || ""} ${c.nickname || ""}`)
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one American Express Platinum card, found ${matches.length}` +
        (matches.length ? `: ${matches.map((c) => `#${c.id} ${c.nickname}`).join(", ")}` : "")
    );
  }
  return matches[0];
}

const differs = (benefit, values) =>
  Object.entries(values).some(([k, v]) => benefit[k] !== v);

// `repo` is injected so the unit test can run this without a database.
export async function seed({ repo, dryRun = false }) {
  const summary = [];
  const card = findPlatinumCard(await repo.getCatalog());
  const byName = (name) => card.benefits.find((b) => b.name === name);
  summary.push(`card: #${card.id} ${card.nickname}`);

  // 1. Lodging Credit (rename-in-place of the old Semi-Annual Hotel Credit).
  const lodging = byName(LODGING_NAME) || byName(OLD_LODGING_NAME);
  if (!lodging) {
    summary.push(`${LODGING_NAME}: ${dryRun ? "would create" : "created"}`);
    if (!dryRun) await repo.createBenefit({ card_id: card.id, ...LODGING_VALUES });
  } else if (!differs(lodging, LODGING_VALUES)) {
    summary.push(`${LODGING_NAME}: skipped (#${lodging.id} already up to date)`);
  } else {
    summary.push(`${LODGING_NAME}: ${dryRun ? "would update" : "updated"} #${lodging.id} (was "${lodging.name}")`);
    if (!dryRun) await repo.updateBenefit(lodging.id, LODGING_VALUES);
  }

  // 2. Airbnb Experiences Credit + its match rule.
  let experiences = byName(EXPERIENCES_NAME);
  if (experiences) {
    summary.push(`${EXPERIENCES_NAME}: skipped (#${experiences.id} exists)`);
  } else {
    summary.push(`${EXPERIENCES_NAME}: ${dryRun ? "would create" : "created"}`);
    if (!dryRun) experiences = await repo.createBenefit({ card_id: card.id, ...EXPERIENCES_VALUES });
  }
  if (experiences && (experiences.rules || []).length > 0) {
    summary.push(`${EXPERIENCES_NAME} rule: skipped (${experiences.rules.length} already exist)`);
  } else {
    summary.push(`${EXPERIENCES_NAME} rule (${RULE_VALUES.merchant_regex}, ${RULE_VALUES.direction}): ${dryRun ? "would create" : "created"}`);
    if (!dryRun) {
      // Validated at save time, as POST /api/benefits/rules does.
      await repo.assertValidRegex(RULE_VALUES.merchant_regex);
      await repo.createRule({ benefit_id: experiences.id, ...RULE_VALUES });
    }
  }
  return summary;
}

async function main() {
  const { default: dotenv } = await import("dotenv");
  dotenv.config();
  const dryRun = process.argv.includes("--dry-run");
  // Imported after dotenv: db.js reads DATABASE_URL when it loads.
  const repo = await import("../benefits/repository.js");
  const { default: pool } = await import("../db.js");
  try {
    if (dryRun) console.log("DRY RUN: no writes");
    for (const line of await seed({ repo, dryRun })) console.log(line);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
