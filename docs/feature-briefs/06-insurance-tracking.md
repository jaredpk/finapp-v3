# Brief 06 — Insurance Program Tracking

**Question asked:** can FinApp carry a section that tracks current insurance
status, modeled on the `insurancecomparisonv2.xlsx` workbook — accept renewal
documents and declarations pages from each carrier, and use AI to keep it
updated and analyzed?

**Verdict: viable, and the single best fit for AI in this codebase so far —
with one caveat that has to shape the design rather than be noted at the end.**
Roughly **L, ~4–6 days** across three phases, larger than Brief 05 (Benefits)
mostly because of the document vault and the review UI, not the AI.

The caveat: **the workbook is not a register, it is an analysis — and it ships
with its own correction log.** Tab 6, `Corrections`, records eleven places where
the earlier analysis disagreed with the issued policy documents, and in every
one of them the document won. That tab is the requirement. An app that stores
"what the AI said" without storing "which page it read and whether a later
document overruled it" will reproduce exactly the drift that tab exists to
catch, except silently and at machine speed. Evidence and supersession are load
bearing here in a way they were not for Benefits.

---

## What the codebase already gives us

| Need | Already there |
|---|---|
| Self-contained module pattern | `server/benefits/` and `server/property/` — own `schema.js`, `repository.js`, `routes.js`, own table prefix, schema mounted from `initDb()` (`server/db.js:587`) |
| Pure, I/O-free core to unit-test | `server/benefits/periods.js` — `resolvePeriod`, `evaluateBenefits` (`:133`, `:415`), no pg and no express, tested in `server/test/` |
| Structured LLM extraction, already priced and guarded | `extractReceipt` in `server/receiptScan.js:140-173` — `generateContent` with `responseMimeType: "application/json"` + `responseSchema`, then `recordGeminiCall` |
| A spend guard that already covers a new caller | `server/geminiUsage.js` — rate table at `:29-37`, monthly ceiling, `feature` column on every usage row |
| A "this document isn't what you think it is" escape hatch | `is_receipt: false` (`server/receiptScan.js:155`) — the exact shape the insurance extractor needs (see "Junk in the pile") |
| Base64 file upload with a preview/commit split | `POST /api/property-finance/properties/:id/import/upload` (`server/property/routes.js:212-235`) — `mode: "preview" \| "commit"`, parse failures return 400 with the reason |
| Blob storage, with no new dependency and no new secret | Supabase service-role client already constructed at `server/index.js:80` from `SUPABASE_SERVICE_KEY`. Supabase Storage is reachable today |
| A scheduler | `.github/workflows/benefits-alerts.yml:17` — daily cron posting to `/api/alerts/run` (`server/index.js:877`) behind `requireApiKeyOrAuth` (`server/index.js:304`) |
| An outbound email channel | `server/alertEmail.js` → `sendMail` in `server/gmail.js`; `GMAIL_SCOPES` (`server/gmail.js:23`) now includes send. **Brief 05's "no outbound message channel" gap is closed** — renewal reminders need no new plumbing |
| Nav + view wiring | `NAV` array in `client/src/components/Sidebar.jsx:3-14`, `VIEWS` map in `client/src/App.jsx` |
| Ask AI extensibility | one tool declaration in `server/askAi.js` and "when does my flood policy renew?" answers itself |

Nothing here needs a new npm dependency. That matters: production is a 256 MB
Fly VM (`fly.toml`) with `min_machines_running = 0`.

---

## What the workbook actually is

Seven tabs, and they are not seven views of one thing:

| Tab | What it really is | Maps to |
|---|---|---|
| `Summary` | A narrative of one restructuring event | Derived, plus owner prose |
| `Cost Detail` | Premium by policy, before vs after, annualized, plus payment channel | Derived from policy rows |
| `Coverage` | Line-by-line coverage comparison, before vs after | Derived from two policy sets |
| `Open Items` | 23 tracked findings: priority, owner, why it matters | **Persisted, owner-owned lifecycle** |
| `Resolved` | 15 findings closed *by a document*, with what the document showed | The same table, later state |
| `Corrections` | 11 places the analysis was wrong and the document was right | The supersession mechanism |
| `Assumptions` | Estimates you may change, and the source-document register | Persisted; overrides + documents |

Three consequences for the data model.

**1. `Open Items` and `Resolved` are one table, not two.** A finding moves
`open → resolved` and carries *what closed it*. The `Resolved` tab's third
column is always a document citation ("PUP 325C requires…", "Not in the 2026–27
form schedule"). That column is the evidence link, and it is the most valuable
field in the entire workbook.

**2. Before/after should not be its own table.** Give each policy a `status`
(`in_force`, `quoted`, `replacing`, `replaced`, `declined`) and an optional
`supersedes_policy_id`. Then `Cost Detail` and `Coverage` are both derived: the
"before" set is what is being replaced, the "after" set is what replaces it. The
workbook's `Progressive/Homesite home quote — REJECTED` row (`Assumptions`, r21)
is a `declined` policy, and keeping it is the point — it records why the
cheaper-looking option was turned down.

**3. `Corrections` means findings are versioned, not edited.** When a document
overrules an earlier conclusion, the old finding is marked superseded with a
pointer to the new one; it is not overwritten. Otherwise the app cannot answer
"why did we think that?", which is the question that tab was written to answer.

---

## The real design problems

### 1. Extraction is not derive-on-read, and pretending otherwise will hurt

Brief 05's rebuild established the house rule: derived state is not persisted,
because keeping it consistent is where the bugs live. Insurance has to depart
from that, and the departure needs to be principled rather than convenient.

`evaluateBenefits` is a pure function — same transactions, same rules, same
date, same answer, for free. An LLM reading a PDF is neither pure nor free: the
same document and the same prompt can produce different JSON, and each pass
costs money against `GEMINI_MONTHLY_BUDGET_USD`. It cannot run on every GET.

The resolution is to be precise about which half is which:

- **The document is an input.** Immutable, hashed, stored once.
- **The extraction is a recorded observation, not derived state.** It persists
  as JSONB keyed by `(document_id, prompt_version, model)` and is **never
  updated in place**. A prompt change writes a new row; the old one stays,
  because a finding may cite it. This is the same category as `cb_alerts` in
  Brief 05 — a genuine side-effect record of something that actually happened,
  which the doctrine already permits.
- **Everything above the extraction is derived on read, and must be pure.**
  Premium rollups, the annualization of six-month auto terms, the before/after
  coverage comparison, the renewal calendar, the forms-schedule diff. That code
  goes in `server/insurance/derive.js` with no pg and no express import, tested
  the way `periods.js` is tested.
- **Owner corrections persist separately and win.** `ins_overrides`, keyed
  `(policy_id, field_path)` — the direct analogue of `cb_manual_marks`. The read
  model resolves each field as `override > latest extraction > null`, which is a
  pure function and therefore testable.

Do not normalize extracted coverage lines into their own table. Keep the
extraction as one JSONB blob and normalize on read. A `ins_coverages` table
would need to be kept consistent with the extraction that produced it, which is
the precise failure Brief 05 rebuilt to escape.

### 2. The uploaded pile is heterogeneous, and one file in it is blank

The nine PDFs in `Insurance details.zip` are five different kinds of document,
and the extractor's first job is to say which:

| Kind | Example | Characteristics |
|---|---|---|
| Full policy packet | `USAA Florida Homeowners Keeping.pdf` (34 pp) | Cover letter, declarations page, forms schedule, then the policy form text |
| Declarations-only renewal | `Neptune Flood.pdf` (38 pp) | Welcome letter + dec + full form |
| Carrier web coverage screen | `Progressive - Utah Auto Adding.pdf` (3 pp) | Coverage lines and per-coverage premiums, **no policy number, no term dates, no named insured** |
| Signed application | `RLI Umbrella/download (2).pdf` (9 pp) | Underwriting answers — the source of both CRITICAL findings |
| **A blank specimen** | `RLI Umbrella/download (1).pdf` (1 p) | Literally reads `Month DD, YYYY`, `Named Insured 1`, `Mailing address line 1` |

That last one is not a hypothetical. It is an unfilled template sitting in the
real upload, and a model asked to "extract the policy details" will cheerfully
return `Named Insured 1` as a name. **Reuse the receipt scanner's exact escape
hatch:** a required `document_kind` enum with `unusable` as a member, plus a
`reason`, refused before anything is written — the same shape as
`is_receipt: false` at `server/receiptScan.js:155`.

Three more traps that the actual files demonstrate:

- **Absent ≠ null.** The Progressive coverage screens state no policy term. The
  workbook's own `Open Items` r16 is "Confirm the Progressive Utah policy term
  and annualized premium" *because the document does not say*. Every extracted
  field needs three states — a value, `not_stated_in_document`, and
  `unreadable` — or the app will silently render a blank where the correct
  answer is "go get this."
- **Mailing address ≠ risk address.** Page 1 of `USAA Florida Homeowners` shows
  `HERRIMAN UT 84096`; the declarations page on page 6 shows the actual insured
  premises, `20007 LARINO LOOP, ESTERO, LEE, FL`. Extracting from the first page
  that looks authoritative gets the Florida policy filed under the Utah house.
- **Six-month terms.** `Cost Detail` r2 says "Six-month auto premiums are
  doubled." Store the term premium and the term length as extracted; annualize
  in `derive.js`. Never store the annualized number as if it were on the page.

### 3. The forms schedule is the highest-value object in the packet, and it diffs deterministically

The USAA declarations carry a structured forms schedule — form code, edition
date, title — grouped under `REMAIN IN EFFECT` and `ADDED`:

```
HO-3RFL      (09-16) HOMEOWNERS SPECIAL FORM
HO-SLS3FL    (05-16) SPECIAL LOSS SETTLEMENT
HO-125FL     (09-16) HOME PROTECTOR
HO-208FL     (12-15) WATER BACKUP OR SUMP PUMP OVERFLOW
ADDED:
HO-CGCC      (08-16) CATASTROPHIC GROUND COVER COLLAPSE
219          (05-16) BUILDING CODE CREDIT
```

The workbook's URGENT finding — "Restore Ordinance or Law coverage at 25%
(HO-225FL)" — is a **set difference between this year's schedule and last
year's**. So is `Resolved` r7, "Confirm HO-225FL is in force → CLOSED —
negative. Not in the 2026–27 form schedule."

That is arithmetic, not judgment. Extract the schedule as a list of
`{code, edition, title, disposition}`, and compute year-over-year adds and drops
in `derive.js` as a pure function. A dropped endorsement is then surfaced with
100% recall and zero model involvement, which is a much stronger guarantee than
anything the LLM tier can offer. **Build this before the analysis tier** — it is
cheaper, more reliable, and catches the class of problem that actually cost
money here.

The credits-and-discounts block on the same page diffs the same way, and answers
`Open Items` r15 ("confirm which USAA credits actually drop").

### 4. Cross-policy findings are the product, and they need citations

The two CRITICAL findings are not extractions. They are conclusions drawn across
four documents at once — RLI's signed application question 26, RLI endorsement
PUP 325C, PUP 320's definition of *Relative*, and the underlying auto limits on
a policy that is not in the file at all. That reasoning is where an LLM earns
its place; single-document field extraction is the boring part.

Constraints on that tier, all of them non-negotiable:

- **Every finding cites `(document_id, page)`.** A finding that cannot cite is
  not stored. This is the mechanism that makes the `Corrections` tab possible
  and it is what stops confident invention.
- **The model proposes; the owner accepts.** New findings land in a review queue
  in the amber state the receipt-scan workflow already established, never
  directly into the open list.
- **A finding may cite absence, but only from a structured absence.** "HO-225FL
  is not in the schedule" is legitimate because the schedule was extracted as a
  list. "The policy doesn't cover X" from a 34-page form is not, unless it
  quotes the exclusion.
- **The app states what the documents say. It does not give coverage advice.**
  Render findings as *this document says X, which conflicts with Y* — sourced,
  attributable, and checkable. The workbook's own line (`Assumptions` r23,
  "Prepared as a personal coverage review. Not legal, tax, or insurance advice")
  belongs in the UI, not just in a file.

### 5. The renewal calendar is the feature that pays for itself, and it is nearly free

Six policies, and from the documents there are four distinct anniversaries and
two unknowns:

| Policy | Term |
|---|---|
| USAA FL homeowners | 10/12/26 – 10/12/27 |
| USAA UT homeowners | 10/12/26 – 10/12/27 |
| RLI umbrella | 09/06/26 – 09/06/27 |
| Neptune flood | 03/05/26 – 03/05/27 — surplus lines, deliberately off-cycle |
| Progressive FL auto | **not stated on the coverage screen** |
| Progressive UT auto | **not stated on the coverage screen** |

`Open Items` r8 is a sequencing risk between a cancellation and an inception
date, and it carries real money: "A lapse breaks the RLI Basic Policy condition;
an overlap costs money." A renewal calendar with a lead-time reminder is the
highest value-per-line-of-code in this brief, it needs no AI at all, and both
halves of its plumbing already exist — the GitHub Actions cron and
`sendMail`. Ship it in phase 1.

Two details: a policy whose term is `not_stated_in_document` must render as
*term unknown — confirm with carrier*, never as no upcoming renewal; and the
`ins_alerts` table is keyed `(policy_id, renewal_date, tier)` so a re-run
cannot double-send, exactly as `cb_alerts` is.

---

## Storage: where the PDFs live

They must be retained — every finding cites a page, so discarding the source
breaks the core mechanism. The property importer's parse-and-discard model does
not transfer.

**Recommended: Supabase Storage, browser → storage directly via a signed upload
URL.** The service-role client already exists (`server/index.js:80`), the secret
is already set, no dependency is added, and the bytes never transit the 256 MB
VM on the way in. The server mints the URL, then records `ins_documents` with
the storage path and a SHA-256 of the content for dedupe.

Rejected:

- **Postgres `bytea`.** Works, adds nothing to install, and puts multi-megabyte
  blobs in the row store of a database this app reads with `SELECT *` habits.
  The upload set alone is 7.5 MB for nine files.
- **A Fly volume.** Single-region, does not survive a machine replacement
  without care, and backups become a manual job. Wrong trade for documents whose
  whole purpose is to be the durable record.
- **Routing uploads through `express.json`.** `server/index.js:116` sets
  `limit: "50mb"` globally. A 50 MB base64 body on a 256 MB VM already sitting
  around 173 MB RSS is an OOM, not a request. If a server-side upload route is
  built anyway, cap insurance uploads at ~10 MB per file at the route.

---

## Extraction pipeline

Send the **PDF itself** to Gemini, not server-extracted text. Evidence for this
from the actual files: text extraction of the USAA declarations page returns

```
    $554,000COVERAGE A - DWELLING PROTECTION
     $55,400COVERAGE B - OTHER STRUCTURES PROTECTION
```

— the amount ahead of the label it belongs to, because these are two-column
layouts. Feeding that to a model is asking it to reconstruct a table that the
extractor destroyed. Native PDF input also means **no PDF library is added**, no
new memory pressure, and no OCR path to maintain for the day a carrier sends a
scan.

Cost is not the constraint. All nine files are ~175 pages; at Google's PDF page
tokenization that is roughly 45k input tokens, which against the app's own rate
table (`server/geminiUsage.js:34-36`, `gemini-2.5-flash` at $0.30/M input) is
about **$0.015 to re-extract the entire corpus**. Add an `INSURANCE_MODEL` env
var alongside `RECEIPT_MODEL`, and a `feature: "insurance_extract"` value on the
usage row so it shows up separately on the settings card.

Flow, mirroring the property importer's preview/commit split
(`server/property/routes.js:212`):

1. Upload → `ins_documents` row, status `pending`.
2. Extract → classify `document_kind`; refuse `unusable`; otherwise write one
   immutable `ins_extractions` row of JSONB against a versioned schema.
3. **Preview**: render the extraction as a diff against the current policy
   record — confirm / change / ignore per field, never a blank form. Same
   posture as Brief 05's guided catalog review.
4. **Commit**: accepted values land as `ins_overrides` where they differ from
   the extraction; the policy's `verified_on` is stamped.
5. Findings pass (separate call, phase 3) → proposals into the amber queue.

Steps 3 and 4 are not optional polish. An extraction that writes straight
through is how the `Corrections` tab gets recreated.

---

## Sketch of the work

**Server — `server/insurance/`** (mirroring `server/benefits/`):

- `schema.js` — `initInsuranceSchema(pool)`, called from `initDb()` next to
  `initBenefitsSchema` (`server/db.js:587`):
  - `ins_policies` — owner spine: nickname, carrier, product, `kind`
    (`auto|home|flood|umbrella|valuables|other`), policy_number, term_start,
    term_end, term_months, term_premium, payment_channel (the `Cost Detail`
    "escrowed through Chase" fact), `status`, `supersedes_policy_id`,
    `verified_on`.
  - `ins_documents` — storage_path, sha256, filename, uploaded_at, page_count,
    `document_kind`, linked policy (nullable — a document may arrive before its
    policy exists).
  - `ins_extractions` — document_id, prompt_version, model, `payload JSONB`,
    extracted_at. **Insert-only.** UNIQUE `(document_id, prompt_version)`.
  - `ins_overrides` — policy_id, field_path, value, note. UNIQUE
    `(policy_id, field_path)`. Wins over extraction.
  - `ins_findings` — priority, title, rationale, owner, status
    (`proposed|open|resolved|superseded`), `superseded_by_id`, resolved_note.
  - `ins_finding_evidence` — finding_id, document_id, page, quote.
  - `ins_alerts` — policy_id, renewal_date, tier, sent_at. Idempotent.
- `derive.js` — **pure, no pg, no express.** Field resolution
  (`override > extraction > null`), six-month annualization, premium rollups by
  carrier and payment channel, before/after comparison across
  `supersedes_policy_id`, forms-schedule set-difference, renewal calendar and
  lead-time tiers. This is the file that gets the tests.
- `extract.js` — the Gemini call, `responseSchema`, `recordGeminiCall`, budget
  gate. Same structure as `receiptScan.js`.
- `routes.js` — `GET /api/insurance/status`, `GET /api/insurance/policies`,
  policy/finding CRUD, `POST /api/insurance/documents/upload-url`,
  `POST /api/insurance/documents/:id/extract`,
  `POST /api/insurance/documents/:id/commit`,
  `POST /api/insurance/renewals/check` behind `requireApiKeyOrAuth`.
  Registered in `server/index.js` beside `registerBenefitsRoutes` (`:335`).
- One tool in `server/askAi.js`.
- Renewal email composed in `alertEmail.js` style — pure composition, delivery
  through `sendMail`.

**Client**:

- `views/Insurance.jsx` + `{ id: "insurance", label: "Insurance", icon: "☂" }`
  in `Sidebar.jsx:3-14` and the `VIEWS` map in `App.jsx`.
- Tabs mirroring the workbook: **Program** (the `Summary` + `Cost Detail`
  rollup), **Coverage** (before/after comparison), **Open Items** (the findings
  list with priority chips and the amber proposal queue), **Documents** (the
  vault, with per-document extraction state and `verified_on`).
- `components/insurance/` — `DocumentUpload.jsx`, `ExtractionReview.jsx` (the
  diff), `FindingList.jsx`, `CoverageCompare.jsx`, `RenewalTimeline.jsx`.
- A compact "renewals in the next 60 days / open CRITICAL items" card on the
  Dashboard.

**Infra**: extend `.github/workflows/benefits-alerts.yml` or add a sibling
workflow posting to `/api/insurance/renewals/check`. Same secrets pattern.

---

## Phasing

| Phase | Contents | Value | Est. |
|---|---|---|---|
| **1 — Register + calendar** | Schema, policy CRUD, document vault (upload + store + view, no AI), renewal calendar, email reminders, `derive.js` rollups + tests | Everything the workbook's `Cost Detail` does, plus the lapse/overlap protection it does not | ~2 days |
| **2 — Extraction** | Gemini PDF extraction, `document_kind` classification, preview/commit diff review, forms-schedule diff (deterministic) | Stops the retyping; catches dropped endorsements with no model judgment involved | ~1.5–2 days |
| **3 — Findings** | Cross-policy analysis pass, evidence citations, proposal queue, supersession | The `Open Items` / `Resolved` / `Corrections` loop | ~1.5–2 days |

Phase 1 is independently useful and involves no AI at all. If phases 2 and 3
were never built, the renewal calendar alone would have caught `Open Items` r8.

---

## What cannot be automated

- **The decision.** Whether to carry sinkhole coverage, or accept a 2% hurricane
  deductible, is a risk-tolerance question. The app tracks it as an open item
  and can show what the documents say; it should not recommend.
- **Anything not in the documents.** Both CRITICAL findings turn on facts held
  by third parties — whether a household member is licensed, and what limits
  another person's auto policy carries. No amount of parsing produces these.
  They are open items with an owner and a due date, forever.
- **Carrier confirmation.** `Open Items` r6 needs a signed selection form; r7
  needs a written eligibility determination. The app can generate the ask and
  track that it went out. It cannot close the item.
- **Form text that was never delivered.** `Open Items` r11 wants HO-SLS3FL,
  which is listed in the schedule but not supplied in the packet. The forms diff
  can flag "referenced but not in the vault" — which is genuinely useful, and is
  the limit of what is possible.

---

## Verify before building

1. **Whether Supabase Storage is enabled on the project**, and what the bucket
   and RLS posture should be. The service key is present; the bucket may not be.
   This is the one external prerequisite in phase 1.
2. **What the Progressive documents look like when they are declarations rather
   than a coverage screen.** Two of six policies currently have no term dates
   because of the artifact type, and that shapes how loudly "term unknown" needs
   to render.
3. **Whether prior-year declarations exist** for both USAA homeowners policies.
   The forms-schedule diff — the strongest deterministic win in the brief — needs
   two terms to compare. With only 2026–27 in hand it can flag a schedule but
   not a drop.
4. **One end-to-end extraction on `USAA Utah Homeowners Keeping.pdf` (14 pp)
   before committing to the schema.** It is the smallest full packet with a
   clean declarations page and a forms schedule, and it will tell you within an
   hour whether the JSONB shape survives contact.
5. **That the extractor refuses `RLI Umbrella/download (1).pdf`.** It is a blank
   template. If the first extraction run returns `Named Insured 1` as a named
   insured, the `unusable` classification is not working, and everything
   downstream inherits the failure.
