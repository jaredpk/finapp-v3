// Insurance program tracking schema (Brief 06, phase 1). Tables are prefixed
// `ins_` so they sit alongside the `pf_` property-finance and `cb_` card-benefit
// tables without any of the three modules having to know the others exist.
//
// Called once from server/db.js#initDb() next to initBenefitsSchema.
//
// The shape of this schema is driven by one fact from the brief: the workbook it
// replaces ships with its own `Corrections` tab, eleven places where an earlier
// analysis disagreed with the issued document and the document won. So the
// storage rules here are not the usual CRUD rules:
//
//   - a DOCUMENT is an immutable input, hashed once and kept forever, because
//     every finding cites a page of one;
//   - an EXTRACTION is a recorded observation of a document, never derived
//     state, and never updated in place (see ins_extractions);
//   - an OVERRIDE is the owner disagreeing with an extraction, stored
//     separately so both survive;
//   - a FINDING is versioned by supersession, not edited, so "why did we think
//     that?" stays answerable.
//
// Everything ABOVE the extraction — annualized premiums, before/after
// comparison, the renewal calendar, the forms-schedule diff — is derived on
// read in derive.js and stored nowhere, which is the house rule Brief 05
// established.
export async function initInsuranceSchema(pool) {
  await pool.query(`
    -- The owner-maintained spine. One row per policy the household holds, has
    -- held, or was quoted and turned down. Extractions and overrides hang off
    -- it; nothing in here is written by the model.
    CREATE TABLE IF NOT EXISTS ins_policies (
      id SERIAL PRIMARY KEY,
      nickname TEXT NOT NULL,        -- what the owner calls it ("USAA FL homeowners")
      carrier TEXT,
      product TEXT,
      -- CHECKed rather than free text for the same reason the cb_benefits enums
      -- are: derive.js and the client both branch on this (a six-month auto
      -- term annualizes, an annual home term does not), and a typo'd kind would
      -- silently pick the wrong branch with nothing looking wrong.
      kind TEXT NOT NULL DEFAULT 'other'
        CHECK (kind IN ('auto','home','flood','umbrella','valuables','other')),
      policy_number TEXT,
      -- NULLABLE ON PURPOSE, and this is load bearing. Two of the six real
      -- policies are Progressive coverage screens that state no term at all
      -- (brief, "The renewal calendar is the feature that pays for itself"), and
      -- the correct rendering for those is "term unknown — confirm with
      -- carrier", never "no upcoming renewal". NOT NULL here would force
      -- whoever entered them to invent a date instead.
      term_start DATE,
      term_end DATE,
      term_months INTEGER,
      -- The premium AS PRINTED, for the term as printed. Never the annualized
      -- figure: "Cost Detail" r2 doubles six-month auto premiums, and storing
      -- the doubled number as if it were on the page is how the source document
      -- and the app stop agreeing. annualizePremium() in derive.js does the
      -- multiplication on read.
      term_premium NUMERIC(12,2),
      -- Free text on purpose. The real values are "direct draft",
      -- "Chase mortgage escrow" and "annual ACH" — a billing arrangement
      -- described in prose on a declarations page, not a closed set, and an
      -- enum here would either lose the detail or need a migration per carrier.
      payment_channel TEXT,
      -- The before/after axis. Per the brief's second data-model consequence,
      -- the workbook's Cost Detail and Coverage tabs are not their own tables:
      -- they are this column plus supersedes_policy_id, derived two ways.
      -- "declined" is kept deliberately — the rejected Progressive/Homesite
      -- home quote records WHY the cheaper-looking option was turned down, and
      -- deleting it loses the only copy of that reasoning.
      status TEXT NOT NULL DEFAULT 'in_force'
        CHECK (status IN ('in_force','quoted','replacing','replaced','cancelled','declined')),
      -- Which policy this one replaces. ON DELETE SET NULL rather than CASCADE:
      -- deleting the old policy must not delete the one that replaced it, and a
      -- pairing that can no longer be drawn should degrade to an unpaired
      -- "added" row in compareProgram(), not to a missing row.
      supersedes_policy_id INTEGER REFERENCES ins_policies(id) ON DELETE SET NULL,
      verified_on DATE,              -- when the owner last checked this against an issued document
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ins_policies_supersedes_idx ON ins_policies (supersedes_policy_id);

    -- The document vault. Immutable inputs: the bytes live in blob storage and
    -- this row is the pointer plus everything derivable from the file itself.
    CREATE TABLE IF NOT EXISTS ins_documents (
      id SERIAL PRIMARY KEY,
      storage_path TEXT,             -- key in the bucket; NULL only while an upload is in flight
      -- Content hash, UNIQUE. Re-uploading the same declarations page — which
      -- happens the moment two people forward the same carrier email — must
      -- collide here rather than create a second document, because a second
      -- document would be extracted a second time and double-count its premium
      -- in every rollup that reads it.
      sha256 TEXT UNIQUE,
      filename TEXT,
      byte_size BIGINT,
      page_count INTEGER,
      -- What KIND of artifact this is, which is the extractor's first job and
      -- not a formality: the nine real PDFs are five different kinds of
      -- document, and one of them is an unfilled blank specimen that reads
      -- "Named Insured 1". "unusable" is the receipt scanner's is_receipt:false
      -- escape hatch (server/receiptScan.js:155) — a classification that
      -- refuses the file instead of extracting nonsense from it.
      -- "unclassified" is the state BEFORE extraction has run, so a freshly
      -- uploaded document is not silently mislabelled as one of the real kinds.
      document_kind TEXT NOT NULL DEFAULT 'unclassified'
        CHECK (document_kind IN ('unclassified','declarations','policy_packet','application',
                                 'coverage_screen','quote','correspondence','unusable')),
      -- NULLABLE, and ON DELETE SET NULL. A document routinely arrives before
      -- anyone has created its policy row (that is what the preview/commit flow
      -- is for), and deleting a policy must not destroy the evidence that was
      -- filed under it — ins_finding_evidence may cite this document.
      policy_id INTEGER REFERENCES ins_policies(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ins_documents_policy_idx ON ins_documents (policy_id);

    -- One recorded observation of one document by one prompt version.
    --
    -- INSERT-ONLY. Nothing may UPDATE a row in this table, ever. A prompt change
    -- or a model change writes a NEW row and leaves the old one exactly as it
    -- was, because a finding may cite the old one and the whole point of the
    -- Corrections tab is being able to answer "why did we think that?". An
    -- UPDATE here rewrites history under a citation that still points at it,
    -- which is the silent, machine-speed version of the drift this feature
    -- exists to catch.
    --
    -- The payload stays ONE JSONB blob and is normalized on read (derive.js).
    -- An ins_coverages table would have to be kept consistent with the
    -- extraction that produced it, which is the precise failure Brief 05 was
    -- rebuilt to escape.
    CREATE TABLE IF NOT EXISTS ins_extractions (
      id SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES ins_documents(id) ON DELETE CASCADE,
      prompt_version INTEGER NOT NULL,
      model TEXT NOT NULL,           -- e.g. gemini-2.5-flash; the rate table keys off it
      payload JSONB NOT NULL,        -- see EXTRACTION_PAYLOAD in derive.js
      extracted_at TIMESTAMPTZ DEFAULT NOW(),
      -- One extraction per (document, prompt version). A re-run of the same
      -- prompt over the same document is a retry, not a new observation, so it
      -- must collide here instead of leaving two rows that derive.js would have
      -- to arbitrate between.
      UNIQUE (document_id, prompt_version)
    );
    CREATE INDEX IF NOT EXISTS ins_extractions_document_idx ON ins_extractions (document_id);

    -- The owner disagreeing with an extraction, and winning. The direct
    -- analogue of cb_manual_marks: the one fact nothing can derive.
    CREATE TABLE IF NOT EXISTS ins_overrides (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER NOT NULL REFERENCES ins_policies(id) ON DELETE CASCADE,
      field_path TEXT NOT NULL,      -- dotted path into the resolved policy, e.g. term_end
      -- JSONB, NOT TEXT. The three-state design depends on it: JSON null ("I
      -- checked, this field is genuinely blank"), "" and 0 are three different
      -- assertions, and a TEXT column flattens all three into something
      -- indistinguishable from "no override recorded". resolveField() reads a
      -- null override as a deliberate answer that still beats the extraction.
      value JSONB,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      -- A plain UNIQUE, the ON CONFLICT target the repository will name: fixing
      -- the same field twice updates one row rather than leaving two overrides
      -- for one field with no rule about which wins.
      UNIQUE (policy_id, field_path)
    );
    CREATE INDEX IF NOT EXISTS ins_overrides_policy_idx ON ins_overrides (policy_id);

    -- The workbook's Open Items and Resolved tabs, which are ONE table in two
    -- states, not two tables. A finding moves proposed -> open -> resolved and
    -- carries what closed it.
    --
    -- No policy_id column on purpose: the findings that matter most are drawn
    -- ACROSS documents and policies at once (the two CRITICAL ones span four
    -- documents and a policy that is not in the vault at all), so the link that
    -- carries meaning is the evidence row, not a single owning policy.
    CREATE TABLE IF NOT EXISTS ins_findings (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      rationale TEXT,
      -- CHECKed, and the ORDER of the five is load bearing rather than
      -- decorative. They are the workbook's own Open Items levels, and the
      -- dashboard card the brief asks for ("open CRITICAL items", client
      -- sketch) is a filter on the top of this list — so the set is closed at
      -- five to keep that filter meaningful. A sixth level invented at write
      -- time ("severe", "p0") would be nobody's idea of less urgent than
      -- 'medium', but the card would not show it: it matches on the literal, so
      -- an unlisted value renders nowhere and the most urgent finding in the
      -- table becomes the one nobody sees. The CHECK turns that into a failed
      -- INSERT the writer has to look at, which is the only place it is cheap.
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('critical','urgent','high','medium','low')),
      owner TEXT,                    -- who has to do the thing; several items are third-party asks
      -- "proposed" is the default because the model PROPOSES and the owner
      -- ACCEPTS: an AI-generated finding lands in the amber review queue the
      -- receipt-scan workflow already established, never straight into the open
      -- list. "superseded" is how a corrected finding is retired — it is never
      -- overwritten, so the earlier conclusion and the document that overruled
      -- it both stay readable.
      status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed','open','resolved','superseded')),
      source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','ai')),
      resolved_note TEXT,            -- what the document showed; the Resolved tab's third column
      resolved_on DATE,
      -- The Corrections mechanism. SET NULL rather than CASCADE: deleting the
      -- replacement must not delete the superseded finding, which is the only
      -- record of the earlier conclusion.
      superseded_by_id INTEGER REFERENCES ins_findings(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ins_findings_superseded_by_idx ON ins_findings (superseded_by_id);

    -- (document, page, quote) for a finding. A finding that cannot cite is not
    -- stored — this is the mechanism that makes the Corrections tab possible and
    -- what stops confident invention.
    CREATE TABLE IF NOT EXISTS ins_finding_evidence (
      id SERIAL PRIMARY KEY,
      finding_id INTEGER NOT NULL REFERENCES ins_findings(id) ON DELETE CASCADE,
      -- ON DELETE RESTRICT, deliberately NOT CASCADE and not SET NULL.
      --
      -- CASCADE would delete the finding when someone tidied up the vault, and
      -- SET NULL would leave a finding asserting something with no source —
      -- which is exactly the uncitable finding this table exists to make
      -- impossible. RESTRICT instead refuses the document delete and makes the
      -- person retire the finding first, consciously. The document is the
      -- durable record; it is the finding that is disposable.
      document_id INTEGER NOT NULL REFERENCES ins_documents(id) ON DELETE RESTRICT,
      page INTEGER,
      quote TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ins_finding_evidence_finding_idx ON ins_finding_evidence (finding_id);
    CREATE INDEX IF NOT EXISTS ins_finding_evidence_document_idx ON ins_finding_evidence (document_id);

    -- Renewal reminders that have actually gone out, exactly as cb_alerts is:
    -- a side-effect record of something that happened, not derived state.
    CREATE TABLE IF NOT EXISTS ins_alerts (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER NOT NULL REFERENCES ins_policies(id) ON DELETE CASCADE,
      renewal_date DATE NOT NULL,
      -- Free TEXT, and deliberately not CHECKed, which is the one enum-shaped
      -- column in this file without one. The reason is cb_alerts.tier, which is
      -- the same: the tier vocabulary belongs to derive.js (renewalTiers), it
      -- grows whenever a lead time is added, and a CHECK here would mean a
      -- migration to ship a reminder. The cost is worth naming, because it is
      -- not zero: this exact string is the third column of the UNIQUE below, so
      -- idempotency is spelling. A caller that writes "renewal-60" where
      -- renewalTiers said "renewal-60d" does not collide with the row already
      -- there, and the owner gets the same reminder twice — which is how a
      -- mailbox learns to ignore this sender. Nothing but renewalTiers' return
      -- value may be written here.
      tier TEXT NOT NULL,            -- from renewalTiers() in derive.js
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      -- One row per tier per renewal date, so the daily cron can re-run (or run
      -- twice) without re-nagging. This is also what caps the "term-unknown"
      -- tier at one message: a policy nobody can date is worth saying once, not
      -- once a day forever. Written only after the mail has actually gone out.
      UNIQUE (policy_id, renewal_date, tier)
    );
    CREATE INDEX IF NOT EXISTS ins_alerts_policy_idx ON ins_alerts (policy_id);
  `);

  // -- Added columns -----------------------------------------------------------
  // CREATE TABLE IF NOT EXISTS says nothing about a table that already exists,
  // so anything added after the first release has to be an idempotent ALTER here
  // as well as a line in the definition above (the audit_log pattern in db.js,
  // and cb_benefits.cycle_anchor in benefits/schema.js).
  //
  // The three below are the columns and enum members that arrived after the
  // brief's own schema sketch (docs/feature-briefs/06-insurance-tracking.md,
  // "Sketch of the work"): `unclassified` as a pre-extraction document kind,
  // `cancelled` as a policy status distinct from `replaced` (a policy can be
  // cancelled without anything replacing it — that is the lapse risk in Open
  // Items r8), and `source` on findings so the amber proposal queue can tell an
  // owner-written item from a model-written one.
  //
  // Each CHECK is dropped and re-added rather than guarded, because
  // ADD CONSTRAINT has no IF NOT EXISTS: dropping first makes the pair a no-op
  // on the second run and a repair on a database that somehow lost it.
  await pool.query(`
    ALTER TABLE ins_documents ADD COLUMN IF NOT EXISTS byte_size BIGINT;
    ALTER TABLE ins_documents DROP CONSTRAINT IF EXISTS ins_documents_document_kind_check;
    ALTER TABLE ins_documents ADD CONSTRAINT ins_documents_document_kind_check
      CHECK (document_kind IN ('unclassified','declarations','policy_packet','application',
                               'coverage_screen','quote','correspondence','unusable'));

    ALTER TABLE ins_policies DROP CONSTRAINT IF EXISTS ins_policies_status_check;
    ALTER TABLE ins_policies ADD CONSTRAINT ins_policies_status_check
      CHECK (status IN ('in_force','quoted','replacing','replaced','cancelled','declined'));

    ALTER TABLE ins_findings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'owner';
    ALTER TABLE ins_findings DROP CONSTRAINT IF EXISTS ins_findings_source_check;
    ALTER TABLE ins_findings ADD CONSTRAINT ins_findings_source_check
      CHECK (source IN ('owner','ai'));
  `);
}
