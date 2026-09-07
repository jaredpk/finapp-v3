import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// The half of insurance tracking the pure tests cannot reach: the columns
// themselves, every CHECK constraint, the uniqueness that makes re-runs
// idempotent, and the one referential rule that is deliberately RESTRICT.
// insuranceDerive.test.js proves the arithmetic; this file proves that the
// storage rules the arithmetic assumes are actually enforced by the database
// the app runs on, rather than only by the code that happens to write to it.
//
// It needs a server, so it is guarded twice, exactly as benefitsDatabase.test.js
// is:
//
//   1. no DATABASE_URL → skipped, because CI and a fresh checkout have none;
//   2. a DATABASE_URL that is not LOOPBACK → skipped, because this file creates
//      and drops a database, and doing that against the production pooler
//      because someone had the wrong shell open is not a risk worth taking.
//      The predicate is db.js's own isLocalConnectionString, which is what
//      decides whether that DSN may drop TLS, and it is checked before any
//      query is issued.
//
// Everything runs in a SCRATCH database created for this file and dropped
// again, so it cannot disturb whatever is in the developer's own.

const ADMIN_URL = process.env.DATABASE_URL || "";
const SCRATCH_DB = `finapp_insurance_test_${process.pid}`;

// The scratch DSN has to be in place BEFORE db.js is imported: it builds its
// Pool from process.env at module scope, and ES modules are cached, so there is
// no second chance to point it somewhere else.
const scratchUrl = (() => {
  try {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${SCRATCH_DB}`;
    return url.toString();
  } catch {
    return "";
  }
})();
if (scratchUrl) process.env.DATABASE_URL = scratchUrl;

const db = ADMIN_URL ? await import("../db.js") : null;
// Same host as the admin DSN — only the database name differs — so checking the
// original is checking where this lands.
const runnable = Boolean(db && scratchUrl && db.isLocalConnectionString(ADMIN_URL));
const skip = runnable
  ? false
  : ADMIN_URL
    ? "DATABASE_URL is not a loopback server; refusing to create a scratch database on it"
    : "no DATABASE_URL";

async function withAdmin(fn) {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, ssl: false });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

let schema;
let pool;

if (runnable) {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  pool = db.default;
  schema = await import("../insurance/schema.js");
  // TWICE, on purpose. Every migration in this file has to be a no-op on the
  // second run — that is what "idempotent" means here, and the DROP CONSTRAINT /
  // ADD CONSTRAINT pairs at the end of schema.js are exactly the shape that
  // works once and then fails on restart if it is written carelessly.
  await schema.initInsuranceSchema(pool);
  await schema.initInsuranceSchema(pool);

  test.after(async () => {
    await pool.end();
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    });
  });
}

const TABLES = [
  "ins_alerts", "ins_finding_evidence", "ins_findings",
  "ins_overrides", "ins_extractions", "ins_documents", "ins_policies",
];

async function reset() {
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

const insertPolicy = async (over = {}) => {
  const row = { nickname: "USAA FL homeowners", kind: "home", status: "in_force", ...over };
  const { rows } = await pool.query(
    `INSERT INTO ins_policies (nickname, carrier, kind, policy_number, term_start, term_end,
                               term_months, term_premium, payment_channel, status, supersedes_policy_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [row.nickname, row.carrier ?? null, row.kind, row.policy_number ?? null,
     row.term_start ?? null, row.term_end ?? null, row.term_months ?? null,
     row.term_premium ?? null, row.payment_channel ?? null, row.status, row.supersedes_policy_id ?? null]
  );
  return rows[0];
};

const insertDocument = async (over = {}) => {
  const row = { storage_path: "ins/doc.pdf", sha256: `sha-${Math.random()}`, filename: "doc.pdf", ...over };
  const { rows } = await pool.query(
    `INSERT INTO ins_documents (storage_path, sha256, filename, byte_size, page_count, document_kind, policy_id)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'unclassified'),$7) RETURNING *`,
    [row.storage_path, row.sha256, row.filename, row.byte_size ?? null,
     row.page_count ?? null, row.document_kind ?? null, row.policy_id ?? null]
  );
  return rows[0];
};

const insertFinding = async (over = {}) => {
  const row = { title: "Restore Ordinance or Law coverage at 25%", ...over };
  const { rows } = await pool.query(
    `INSERT INTO ins_findings (title, rationale, priority, owner, status, source)
     VALUES ($1,$2,COALESCE($3,'medium'),$4,COALESCE($5,'proposed'),COALESCE($6,'owner')) RETURNING *`,
    [row.title, row.rationale ?? null, row.priority ?? null, row.owner ?? null, row.status ?? null, row.source ?? null]
  );
  return rows[0];
};

// A CHECK violation, identified by SQLSTATE and constraint name rather than by
// message text, which is localised and version-dependent.
const isCheck = (name) => (err) => err.code === "23514" && new RegExp(name).test(err.constraint || err.message);
const isUnique = (err) => err.code === "23505";

test("every ins_ table exists after the migration, and a third run changes nothing", { skip }, async () => {
  const listTables = async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'ins\\_%' ORDER BY table_name`
    );
    return rows.map((r) => r.table_name);
  };
  const listColumns = async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'ins\\_%'
       ORDER BY table_name, column_name`
    );
    return rows;
  };

  assert.deepEqual(await listTables(), [...TABLES].sort());
  const before = await listColumns();

  // The migration has already run twice at import. A third run is what a Fly
  // machine restart does, and it has to be a no-op rather than an error.
  await schema.initInsuranceSchema(pool);
  assert.deepEqual(await listColumns(), before);
});

test("term columns are nullable, because two of the six real policies have no stated term", { skip }, async () => {
  await reset();
  // The Progressive coverage screen: a carrier, a premium, and no term at all.
  // NOT NULL here would have forced whoever entered it to invent a date.
  const undated = await insertPolicy({
    nickname: "Progressive UT auto", carrier: "Progressive", kind: "auto",
    term_start: null, term_end: null, term_months: null, term_premium: "950.00",
  });
  assert.equal(undated.term_end, null);
  assert.equal(undated.term_months, null);
  assert.equal(undated.status, "in_force");      // the default

  const { rows } = await pool.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'ins_policies' AND column_name IN ('term_start','term_end','term_months','term_premium')
     ORDER BY column_name`
  );
  assert.deepEqual(rows.map((r) => r.is_nullable), ["YES", "YES", "YES", "YES"]);
});

test("each enum CHECK rejects a value outside its set", { skip }, async () => {
  await reset();
  await assert.rejects(() => insertPolicy({ kind: "boat" }), isCheck("ins_policies_kind_check"));
  await assert.rejects(() => insertPolicy({ status: "lapsed" }), isCheck("ins_policies_status_check"));
  // `cancelled` arrived after the brief's own sketch and is re-asserted by the
  // idempotent ALTER at the end of schema.js; if that ALTER stopped running,
  // this insert would be the one that failed.
  assert.equal((await insertPolicy({ status: "cancelled" })).status, "cancelled");

  await assert.rejects(() => insertDocument({ document_kind: "spreadsheet" }), isCheck("ins_documents_document_kind_check"));
  // The receipt scanner's escape hatch, and the state before it has run.
  for (const kind of ["unclassified", "unusable", "coverage_screen"]) {
    assert.equal((await insertDocument({ document_kind: kind })).document_kind, kind);
  }
  assert.equal((await insertDocument({})).document_kind, "unclassified");

  await assert.rejects(() => insertFinding({ priority: "blocker" }), isCheck("ins_findings_priority_check"));
  await assert.rejects(() => insertFinding({ status: "closed" }), isCheck("ins_findings_status_check"));
  await assert.rejects(() => insertFinding({ source: "vendor" }), isCheck("ins_findings_source_check"));
  // The model proposes; the owner accepts. A finding written with no status
  // lands in the amber queue, not in the open list.
  assert.equal((await insertFinding({})).status, "proposed");
});

test("ins_documents dedupes on sha256, so the same declarations page cannot be counted twice", { skip }, async () => {
  await reset();
  await insertDocument({ sha256: "abc123", filename: "USAA Florida Homeowners.pdf" });
  await assert.rejects(() => insertDocument({ sha256: "abc123", filename: "forwarded copy.pdf" }), isUnique);
});

test("ins_extractions holds one row per (document_id, prompt_version)", { skip }, async () => {
  await reset();
  const doc = await insertDocument({});
  const insert = (promptVersion, payload) => pool.query(
    `INSERT INTO ins_extractions (document_id, prompt_version, model, payload) VALUES ($1,$2,$3,$4) RETURNING *`,
    [doc.id, promptVersion, "gemini-2.5-flash", JSON.stringify(payload)]
  );

  const { rows: [first] } = await insert(1, { carrier: { value: "USAA", state: "value", page: 6 } });
  assert.equal(first.payload.carrier.value, "USAA");

  // A re-run of the SAME prompt over the same document is a retry, not a new
  // observation.
  await assert.rejects(() => insert(1, { carrier: { value: "USAA", state: "value", page: 6 } }), isUnique);

  // A NEW prompt version writes a NEW row and leaves the old one exactly as it
  // was — the table is insert-only because a finding may cite the old row.
  const { rows: [second] } = await insert(2, { carrier: { value: "USAA Casualty", state: "value", page: 6 } });
  assert.notEqual(second.id, first.id);
  const { rows } = await pool.query(`SELECT prompt_version, payload FROM ins_extractions WHERE document_id = $1 ORDER BY prompt_version`, [doc.id]);
  assert.deepEqual(rows.map((r) => r.prompt_version), [1, 2]);
  assert.equal(rows[0].payload.carrier.value, "USAA");   // untouched by the newer reading
});

test("ins_overrides holds one row per (policy_id, field_path), and JSONB keeps null distinct from absent", { skip }, async () => {
  await reset();
  const policy = await insertPolicy({});
  const upsert = (fieldPath, value) => pool.query(
    `INSERT INTO ins_overrides (policy_id, field_path, value) VALUES ($1,$2,$3::jsonb) RETURNING *`,
    [policy.id, fieldPath, JSON.stringify(value)]
  );

  await upsert("term_end", "2027-10-12");
  await assert.rejects(() => upsert("term_end", "2027-10-13"), isUnique);

  // The three assertions a TEXT column would have flattened into one.
  const { rows: [nulled] } = await upsert("policy_number", null);
  const { rows: [empty] } = await upsert("notes", "");
  const { rows: [zero] } = await upsert("term_premium", 0);
  assert.equal(nulled.value, null);
  assert.equal(empty.value, "");
  assert.equal(zero.value, 0);
  // And a field with no override row at all is a fourth, different thing.
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ins_overrides WHERE policy_id = $1 AND field_path = 'carrier'`, [policy.id]);
  assert.equal(rows[0].n, 0);

  // Deleting the policy takes its overrides with it: an override of a field of
  // a policy that no longer exists resolves to nothing.
  await pool.query(`DELETE FROM ins_policies WHERE id = $1`, [policy.id]);
  const { rows: left } = await pool.query(`SELECT COUNT(*)::int AS n FROM ins_overrides`);
  assert.equal(left[0].n, 0);
});

test("ins_alerts holds one row per (policy_id, renewal_date, tier), so a re-run cannot double-send", { skip }, async () => {
  await reset();
  const policy = await insertPolicy({ term_end: "2027-10-12" });
  const send = (tier, renewalDate = "2027-10-12") => pool.query(
    `INSERT INTO ins_alerts (policy_id, renewal_date, tier) VALUES ($1,$2,$3) RETURNING *`,
    [policy.id, renewalDate, tier]
  );

  await send("renewal-60d");
  await send("renewal-14d");                     // a different tier, same renewal
  await send("renewal-60d", "2028-10-12");       // next year's renewal, same tier
  // The daily cron running twice.
  await assert.rejects(() => send("renewal-60d"), isUnique);

  // The term-unknown tier is capped the same way: said once per renewal date,
  // not once a day forever.
  const undated = await insertPolicy({ nickname: "Progressive UT auto", kind: "auto", term_end: null });
  await pool.query(`INSERT INTO ins_alerts (policy_id, renewal_date, tier) VALUES ($1,$2,$3)`, [undated.id, "2026-09-07", "term-unknown"]);
  await assert.rejects(
    () => pool.query(`INSERT INTO ins_alerts (policy_id, renewal_date, tier) VALUES ($1,$2,$3)`, [undated.id, "2026-09-07", "term-unknown"]),
    isUnique
  );
});

test("a document cited by a finding cannot be deleted out from under it", { skip }, async () => {
  await reset();
  const doc = await insertDocument({ filename: "RLI Umbrella application.pdf" });
  const finding = await insertFinding({ priority: "critical", status: "open" });
  await pool.query(
    `INSERT INTO ins_finding_evidence (finding_id, document_id, page, quote) VALUES ($1,$2,$3,$4)`,
    [finding.id, doc.id, 4, "Question 26: any household member without a licence…"]
  );

  // RESTRICT, not CASCADE. A tidy-up of the vault must not silently delete the
  // finding, and it must not leave a finding asserting something with no
  // source — an uncitable finding is the thing this table exists to prevent.
  await assert.rejects(
    () => pool.query(`DELETE FROM ins_documents WHERE id = $1`, [doc.id]),
    (err) => err.code === "23503" && /ins_finding_evidence/.test(err.constraint || err.message)
  );
  const { rows: still } = await pool.query(`SELECT COUNT(*)::int AS n FROM ins_documents WHERE id = $1`, [doc.id]);
  assert.equal(still[0].n, 1);

  // Retiring the finding first is the conscious path: its evidence goes with it
  // (CASCADE on finding_id), and only then may the document go.
  await pool.query(`DELETE FROM ins_findings WHERE id = $1`, [finding.id]);
  const { rows: evidence } = await pool.query(`SELECT COUNT(*)::int AS n FROM ins_finding_evidence`);
  assert.equal(evidence[0].n, 0);
  await pool.query(`DELETE FROM ins_documents WHERE id = $1`, [doc.id]);
});

test("deleting a superseded policy leaves the one that replaced it standing", { skip }, async () => {
  await reset();
  const before = await insertPolicy({ nickname: "Homesite home", status: "replaced" });
  const after = await insertPolicy({ nickname: "USAA home", status: "in_force", supersedes_policy_id: before.id });
  const doc = await insertDocument({ policy_id: before.id });

  // SET NULL on both pointers: the replacement survives as an unpaired "added"
  // row in compareProgram(), and the document survives with no policy, which is
  // the same state it is in between upload and commit.
  await pool.query(`DELETE FROM ins_policies WHERE id = $1`, [before.id]);
  const { rows: [survivor] } = await pool.query(`SELECT * FROM ins_policies WHERE id = $1`, [after.id]);
  assert.equal(survivor.supersedes_policy_id, null);
  const { rows: [orphan] } = await pool.query(`SELECT * FROM ins_documents WHERE id = $1`, [doc.id]);
  assert.equal(orphan.policy_id, null);
});

test("every foreign key is indexed", { skip }, async () => {
  // Not a style point: these are the joins the status read makes on every GET,
  // and an unindexed FK is also a sequential scan on every parent DELETE.
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'ins\\_%' ORDER BY indexname`
  );
  const names = rows.map((r) => r.indexname);
  for (const expected of [
    "ins_policies_supersedes_idx", "ins_documents_policy_idx", "ins_extractions_document_idx",
    "ins_overrides_policy_idx", "ins_findings_superseded_by_idx",
    "ins_finding_evidence_finding_idx", "ins_finding_evidence_document_idx", "ins_alerts_policy_idx",
  ]) {
    assert.ok(names.includes(expected), `missing index ${expected}`);
  }
});
