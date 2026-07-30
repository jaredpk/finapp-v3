# Relocation Scorecard → elevrics.ai
## Feasibility study and product blueprint

**Date:** July 2026
**Source artifact:** `relocation_scorecard_jared.xlsx` — v7, 103 locations × 40 factors, 7 sheets
**Author's note:** every quantitative claim about the spreadsheet below was computed directly from the workbook, not estimated. Method notes are in the appendix.

---

## 1. Executive assessment

**Verdict: build it — but build the thing the spreadsheet actually is, not the thing it looks like.**

The spreadsheet looks like a ranking engine. It is not. It is a *screen* that narrows 103 candidates to a shortlist, plus a large body of honest annotation about why the screen should not be trusted past that point. The workbook says this itself, in `Notes - v7`: *"This model is a screen, and it has done that job."*

That distinction is the whole feasibility question. A ranking engine for relocation is not credibly buildable — I'll show why with numbers from your own file. A screen-plus-shortlist-plus-deep-research product is very buildable, is differentiated, and maps almost perfectly onto what Elevrics presumably wants to demonstrate.

### 1.1 Three measurements from your workbook that should drive the design

I ran the model rather than reading it. Three results matter more than anything else in this document.

**Finding 1 — Your weights barely move the answer, and that will make a slider UI feel fraudulent.**

| Comparison | Rank correlation | Top-10 overlap |
|---|---|---|
| Your custom weights (range 2–8) vs. flat weights (all 1) | **0.990** | **9 / 10** |
| ±20% random jitter on all 40 weights | — | 8.7 / 10 avg |
| ±50% random jitter on all 40 weights | — | 7.2 / 10 avg |

You spent real effort setting 40 weights across a 2–8 range and got a ranking 99% identical to not weighting at all. This is not a flaw in your judgment; it is arithmetic. A weighted mean over 40 moderately correlated factors regresses hard toward the mean, and a 2–8 range is only a 4× spread — nowhere near enough to overcome 40-way averaging.

Weights *do* work, but only when concentrated:

| Persona weighting (8 factors at 8, all others at 0.25) | Overlap with your top 10 | Top result |
|---|---|---|
| Retiree: health + cost + warmth | **0 / 10** | Lewisburg, PA |
| Family with kids | 2 / 10 | Rochester, MN |
| Climate-first | 1 / 10 | Duluth, MN |
| Remote worker, outdoors | 5 / 10 | Ogden, UT |

**Product implication, and it is the single most important design decision in this document:** do not ship 40 independent 1–10 sliders. Users will move them, watch the list not change, and correctly conclude the tool is decorative. Ship a *scarce budget* — a fixed 100 points across ~10 themes, with a per-theme cap — which forces the concentration that makes rankings actually respond to preference. Everything in §4 follows from this.

**Finding 2 — Your scores are far more precise than they are accurate. Ranks must never be shown.**

| Measure | Value |
|---|---|
| Score range across all 103 places | 52.9 → 71.0 (an 18.1-point band on a 0–100 scale) |
| Standard deviation | 3.88 |
| **Median gap between adjacently-ranked places** | **0.092 points** |
| Places within 1.0 point of #1 | 3 |
| Places within 3.0 points of #1 | 8 |
| Score change from a ±1 rubric edit on one weight-8 factor | 0.37 points |
| **Rank movement from that single one-point disagreement** | **≈ 4 places** |
| Median rank movement from any single +1 edit (measured over all 4,120 cells) | 1 place; 90th pct 4; max 9 |

Fort Collins and Ann Arbor are tied at 71.0. Ranks 1 through 8 are separated by less than the error in a single analyst judgment on a single factor. Displaying "#1 Fort Collins, #2 Ann Arbor, #3 Bellingham" is a false-precision machine: it converts a legitimate "these eight places all screen well" into a spurious ordering that users will absolutely treat as meaningful.

**Product implication:** results are **tiers with score bands**, never integer ranks. Section §5.5 specifies how.

**Finding 3 — Evidence coverage degraded as location count grew. This is the real scaling law.**

| Layer | Coverage |
|---|---|
| Scored cells on `Scorecard` | 4,120 / 4,120 (100%) |
| Rows with supporting facts on `Data - Core` (COL, climate, airport, hospital, crime…) | **69 / 103 (67%)** |
| Rows with supporting facts on `Data - Lifestyle` | **69 / 103 (67%)** |
| Rows with researched water tier + strengths + vulnerabilities + outlook | 103 / 103 (100%) |
| Multi-town rows where one score averages two materially different places | **28 / 103 (27%)** |
| International rows where US-written anchors (property tax, retirement tax, healthcare) don't cleanly apply | 24 / 103 (23%) |

When you went 69 → 103 locations, scores scaled linearly and evidence did not follow. `Notes - v7` is explicit: the 34 added rows are *"still first-pass calibration against the Rubric anchors, not verified row by row."*

**This is the operational core of the feasibility case.** The binding constraint on a relocation product is not the number of places or the number of criteria — it is *evidence per cell*, and evidence per cell is what silently collapses when you scale. Any architecture that does not make coverage and confidence first-class, visible, per-cell data will reproduce this failure at 10× the size and 10× the liability.

### 1.2 What's easy, hard, and what breaks

| | Assessment |
|---|---|
| **Easy** | The math. 1,000 places × 60 criteria is 60,000 numbers — under 1 MB. Score it in the browser at 60fps; no scoring service needed. Linear weighted models give free, exact explainability (contribution = weight × score-delta). Filters, saved scenarios, snapshots, sharing: all standard CRUD. |
| **Moderate** | Ingestion pipelines. ~22 distinct national sources for a credible v1 (§6). Each is 1–3 days to build, and each carries a permanent maintenance tail. This is the largest single line item and it is front-loaded engineering, not ongoing labor — *if* you resist hand-scoring. |
| **Hard** | Geographic joins. Your childcare column is state-level data pretending to be town-level. Your water column is basin-level truth correctly applied. The difference between those two is the difference between a defensible product and a sued one. Requires a real place hierarchy and per-observation geo-provenance. |
| **Hard** | Rubric calibration at scale. Converting raw values → 0–10 requires breakpoints that are defensible across the whole distribution. Your housing rubric already does this correctly (`<$300K = 10, $300–425K = 8`, …). Most factors need the same treatment, and re-cutting breakpoints when you go from 103 to 800 places will move every score. |
| **Breaks at scale** | Anything hand-scored. 103 × 40 = 4,120 cells was achievable by one analyst. 800 × 40 = 32,000 cells is not, at any refresh cadence. |
| **Breaks at scale** | Multi-town rows. 27% of your rows already average two places. At broader coverage this becomes the dominant failure mode, and it's invisible to the user. |
| **Breaks at scale** | International. 23% of your rows are already non-US and your own notes say three anchor sets don't apply to them. Don't take this internationally in v1. |
| **Irreducibly subjective** | The 11 dropped criteria — HOA restrictions, noise/rail/flight paths, community engagement, housing stock, infrastructure quality, disaster preparedness, aging accessibility, STR intensity, grocery access, business friendliness, long-term RE trends. Your instinct to drop them was right. **They are not a gap. They are the product's paid tier** (§7). |

### 1.3 Where to simplify for v1

Five cuts, in order of value:

1. **US only.** Drops the 24 international rows and every tax/healthcare/crime comparability problem your notes already flag.
2. **~22 criteria, all machine-derived, none hand-scored.** Rule: a criterion ships in v1 only if it is computable from a national dataset for ≥95% of covered places. Everything else moves to the AI shortlist stage.
3. **Collapse the winter cluster.** `Extreme cold` ↔ `Winter warmth` r = 0.91; `Maintenance burden` ↔ `Extreme cold` r = 0.87; `Maintenance` ↔ `Snow days` r = −0.78. That's four columns measuring one thing and quadruple-weighting it. Replace with a single *winter tolerance curve* (§4.4).
4. **Drop composite criteria that hide their own inputs.** `Climate resilience (30-yr)` bundles heat, drought, water, fire, and humidity — and your own `v5.4` note admits summer humidity is now penalized in two places. Composites can't be explained and can't be audited. Decompose or drop.
5. **No ranks, no 0.1-precision scores, no global leaderboard** at launch.

---

## 2. Best product framing

### 2.1 The four options, scored honestly

| Framing | Fit | Why |
|---|---|---|
| Public lead-generation tool | **Strong, but incomplete** | The screen is genuinely useful free, ranks well for long-tail search ("best places to retire with good water security"), and demonstrates data engineering + AI in one artifact. But lead-gen alone gives you no revenue signal and no reason to maintain the data. |
| Standalone consumer SaaS | **Weak — do not do this** | Relocation is a once-per-7-to-10-years decision. Subscription retention is structurally impossible; you'd churn 90%+ within 4 months of every signup. Any SaaS framing forces you into fake recurring value (alerts, "market updates") that dilutes the product. |
| Public-service content/product hybrid | **Strong** | Matches the artifact's actual character: an honest, well-annotated public screen. Compounding SEO asset. Credibility is the moat, and credibility is exactly what the workbook's "here's what I dropped and why" posture already earns. |
| Premium AI relocation advisory | **Strong as a tier, fatal as the whole product** | High willingness-to-pay, but as a standalone it's a consulting business with a software wrapper — it doesn't scale and it doesn't demo Elevrics' engineering. |

### 2.2 Recommended framing

> **A free, rigorously-sourced public relocation screen, with a paid one-time AI deep-research report on your shortlist — operating as Elevrics' flagship capability demonstration and B2B lead source.**

Hybrid of options 1, 3, and 4. Explicitly *not* option 2.

The strategic logic:

- The **free screen** is the credibility asset and the traffic engine. It must be genuinely, conspicuously honest — confidence badges, source links, visible "we don't know this" — because that honesty is the differentiator against every listicle and every "Top 10 Cities to Retire" content farm. Your workbook already has this voice. Preserve it verbatim in the UI.
- The **paid report** is the revenue and the AI demo. Critically, it is scoped to exactly the criteria that *cannot* be scored at distance — your 11 dropped ones. That's a clean, defensible product boundary: *the free tool tells you where to look; the paid report tells you what the data can't.*
- **Elevrics' actual business** is the B2B/white-label layer and the credibility the whole thing generates. A prospective client who sees a public product with per-cell provenance, confidence propagation, and a verified AI research pipeline has been sold on Elevrics' capabilities more effectively than any deck.

### 2.3 How this demonstrates Elevrics

Make the demonstration explicit and legible — a "How this was built" page is a first-class deliverable, not an afterthought. What it shows:

| Capability | Where it's visible in the product |
|---|---|
| Multi-source data engineering | 22 national pipelines, per-observation vintage and provenance |
| Honest uncertainty modeling | Confidence propagation → score bands → tiers instead of ranks |
| Decision-science design | Weight elicitation that actually discriminates; non-compensatory filters |
| Deterministic/LLM boundary discipline | Scores never touched by an LLM; LLM never reorders a list |
| Grounded AI with verification | Citation-required research with an adversarial verify pass |
| Product judgment | The list of things deliberately *not* built |

That last row is the strongest sales asset you have and almost nobody else has it.

### 2.4 Personas

| # | Persona | Volume | WTP | Priority |
|---|---|---|---|---|
| 1 | **Pre-retirement / early-retirement couple, 55–70.** Optimizing cost, climate, healthcare depth, proximity to adult children. This is literally your spreadsheet's origin. | Medium | **High** ($100–300 for a real report) | **v1 primary** |
| 2 | **Remote-work household, 30–45.** Cost arbitrage + lifestyle + broadband + airport. | **High** | Low | v1 secondary (traffic engine) |
| 3 | **Climate-motivated mover.** Small, growing fast, extremely engaged, strong PR hook. Your water column is the best-in-class asset for this group. | Low-Med | Medium | v1 free-tier hook |
| 4 | **Corporate mobility / HR relocation support.** | Low | **Very high** | Phase 5 (B2B) |
| 5 | **Cross-border retiree / expat.** | Medium | **Very high** | **Defer.** Worst data, highest liability, tax advice adjacency. |

Persona 1 funds it, persona 2 makes it rank in search, persona 3 makes it get written about.

### 2.5 Strongest use cases

1. *"We can live anywhere. Narrow 900 places to 8 we should actually visit."* — the core loop, and the one the spreadsheet proves works.
2. *"Is the place we already picked a mistake?"* — single-place audit against your profile. Cheap to build, high share rate, great top-of-funnel.
3. *"Compare our two finalists on the things that actually differ."* — head-to-head with contribution decomposition.
4. *"Which of our finalists has a water problem in 2050?"* — your differentiated column, and the one nobody else has.

---

## 3. Recommended product architecture

### 3.1 Shape

A three-stage funnel with a hard boundary between deterministic and generative:

```
 STAGE 1 — SCREEN (free, deterministic, instant)
   questionnaire → hard filters → weighted score → tier bands
   ~900 US places → ~20 candidates
   All math in-browser. No LLM anywhere in this stage.
        ↓
 STAGE 2 — COMPARE (free w/ account, deterministic)
   shortlist 3–8, head-to-head, contribution decomposition,
   "what would change if…", save scenario, share snapshot
        ↓
 STAGE 3 — DEEP RESEARCH (paid, LLM, async, cited, verified)
   the 11 unscoreable criteria + user's own questions,
   per-place, grounded in web search, every claim cited,
   adversarially verified, human-skimmed before delivery
```

The boundary between 2 and 3 is the boundary between *what a dataset can know* and *what only research can know*. Your workbook drew that line already; the product just enforces it.

### 3.2 Technical stack

Recommendation for a resource-conscious founder who nonetheless wants this to survive three years:

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | **Next.js (App Router) + TypeScript + Tailwind** on Vercel | SEO matters enormously here (place pages are the content asset). Server components for place pages, client for the scoring interaction. |
| **Scoring** | **In-browser TypeScript over a static JSON bundle** | 900 places × 60 criteria ≈ 400 KB gzipped. Ship it. Slider→result latency of 0ms is the difference between a tool that feels alive and one that feels like a form. Server recomputes only for saved snapshots and audit. |
| Backend | **Next.js route handlers + a small Node service for jobs** | Don't build a separate API in v1. |
| Database | **Postgres (Neon or Supabase)** | Relational is correct here — the data model is genuinely relational. JSONB for snapshots and context packages. |
| ORM | **Drizzle** | SQL-transparent, cheap migrations. |
| Auth | **Supabase Auth or Clerk** — magic link + Google | Do not build auth. Anonymous-first (§8). |
| Job orchestration | **Inngest** (or Trigger.dev) | Deep-research runs are 5–20 min, multi-step, retryable, need durable state. Do not do this in a request handler or a bare queue. |
| AI | **Anthropic API, Claude with server-side web search**, structured outputs | Research agent + separate verifier pass. |
| Vector/search | **None in v1.** pgvector later | You have 900 places and 60 criteria. There is nothing to embed that a `WHERE` clause doesn't do better. Add pgvector only when you have a corpus of research documents worth retrieving across (Phase 5+). |
| Data pipelines | **Python + dbt on a schedule, writing to Postgres**; publish a versioned JSON bundle to CDN on each release | Keep the pipeline repo separate from the app repo. The pipeline is the durable asset. |
| Analytics | **PostHog** (self-host or cloud) | Funnel + session replay on the questionnaire is the single highest-value instrumentation. |
| Payments | **Stripe Checkout**, one-time | No subscription plumbing in v1. |
| Email | **Resend** | Report delivery + magic links. |

**Fast-to-market vs. durable — the one place they diverge.** The tempting shortcut is to keep the data in a spreadsheet (or Airtable) and sync it. Don't. The `observation` → `score` separation (§5) is the thing that makes the product defensible, and it is the thing a spreadsheet structurally cannot express — as your own workbook demonstrates, where the score layer is 100% complete and the evidence layer is 67%. Everywhere else, take the shortcut.

---

## 4. Questionnaire and scoring design

### 4.1 Criteria language vs. proxy language

**Proxy questions, with a criteria-language escape hatch.**

Nobody has an opinion about "Demographics & growth trajectory." Everybody has an opinion about "Do you want somewhere growing and energetic, or settled and stable?"

- **Default path:** 14–18 plain-language questions. Never uses a criterion name.
- **Advanced panel:** exposes the full criteria list with weights, opened by maybe 5% of users, but its existence is a credibility signal and it's how persona 4 evaluates you.
- **Every result explanation speaks criteria language**, so users learn the vocabulary on the way out rather than on the way in.

### 4.2 Questionnaire structure

| Block | Questions | Produces |
|---|---|---|
| **A. Situation** | Who's moving, ages, work status (remote/employed/retired), rough budget band, timeline | Persona prior → sensible default weights, so an abandoned questionnaire still returns something |
| **B. Anchors** | "Where do the people you'd visit most live?" (1–3 places) | Per-user computed proximity criteria (§4.6) |
| **C. Deal-breakers** | 3–6 hard constraints from a curated list (max home price, must have hospital w/ specialists, no place with severe winters, must be in US, ≥X broadband) | Non-compensatory filters |
| **D. Tradeoff budget** | **100 points across 10 themes, max 25 to any one theme** | Concentrated weights — the fix for Finding 1 |
| **E. Tolerance curves** | 4–6 sliders with an *ideal band*, not a direction: winter, summer heat, city size, elevation, density | Utility curves (§4.4) |
| **F. Optional depth** | "Anything else that matters?" free text | Routed to the AI stage; also your best product-research corpus |

Target completion: **under 4 minutes** for block A–D, with results shown immediately and E–F offered as refinement *after* first results. Show results early and let people tune; do not make them earn the payoff.

### 4.3 Why a point budget beats sliders

| Elicitation method | Produces concentration? | Build cost | Recommendation |
|---|---|---|---|
| 40 independent 1–10 sliders | **No** — this is your workbook, r = 0.99 vs. flat | Low | Never |
| 10 theme sliders, 1–5 | Weakly | Low | No |
| **100-point budget across 10 themes, cap 25** | **Yes — forced** | Low | **v1** |
| Forced ranking (drag top 5 of 10) | Yes | Medium | v1 alternative, good on mobile |
| MaxDiff / pairwise tradeoffs (12–15 pairs) | **Yes, and best-calibrated** | High | Phase 4 |

The budget mechanic also produces the emotional core of the product: it makes the user *feel* the tradeoff before they see it. That's a better experience than sliders and it happens to be the only thing that makes the math work.

### 4.4 Tolerance curves, not just weights

The workbook contorts itself around a problem weights can't express. `Snow days` rewards more snow; `Extreme cold` punishes it; the rubric then hand-patches the interaction (*"Duluth 6 despite ~90 in"*, *"Laramie 5 despite ~50 in"*). That's a scoring model fighting its own structure.

The fix: for continuous criteria, keep the **raw value** and let the user specify an ideal band and a tolerance width. Score = a piecewise function of distance from the band.

```
Winter preference:  ideal Jan mean high 30–42°F, tolerance ±8°F
  → Duluth (18°F):        score 2   (far below band)
  → Bellingham (45°F):    score 8   (just above band)
  → Carlsbad (65°F):      score 3   (far above band — too warm, by choice)
```

One criterion, one raw value, no cross-column patching, and it correctly expresses "I want a real winter but not a brutal one" — which four separate weighted columns cannot.

Apply to exactly 6 criteria in v1: winter temperature, summer heat, summer humidity, population size, elevation, home price. Everything else stays monotone.

### 4.5 Must-haves, exclusions, tolerances — and why filters carry the load

Measured on your data:

| Filter set applied to the 103 places | Survivors |
|---|---|
| Water security ≥ 8 | 47 |
| + Medical quality ≥ 7 | 32 |
| + Housing affordability ≥ 6 (relaxing water to ≥6) | 20 |
| + Local politics ≥ 7 and Crime ≥ 7 | **8** |

Five hard constraints do more work than 40 weights. **Filters are the primary interaction; weights order what survives.** Design the UI that way — deal-breakers before the weight budget, and show the survivor count live as constraints are added ("103 → 47 → 32 → 20 → 8") so users feel the funnel and self-correct when they over-constrain.

Guardrails: warn at <12 survivors, auto-suggest the single constraint to relax at <5, and never return an empty list — degrade to "nothing meets all your must-haves; here are the 5 closest, and what each one misses."

### 4.6 Per-user computed criteria

Your `SLC proximity & access` and `Grandkid visit appeal` columns are not properties of a place. They are properties of *your household's relationship to* a place. A product cannot bake in one family's anchor.

Generalize: user names 1–3 anchor locations in block B; the system computes, per candidate place:

- driving time (routing API, cached per place-pair)
- nonstop flight availability from nearest commercial airport to the anchor's airport (BTS T-100 / published schedules)
- total door-to-door friction band (same day drive / same day fly nonstop / connection / full travel day)

This is the single highest-perceived-value computation in the product — it's the thing users can't get anywhere else — and it's one routing API and one flight-schedule table. Build it in v1.

### 4.7 Explainability

Linear models are worth keeping *specifically* because contribution decomposition is exact and free:

> **Rochester, MN — Strong fit (band 71–78)**
> **Lifting it:** Healthcare depth (+8.1 — Mayo, you weighted this 22/100) · Water security (+5.4) · Crime (+3.2)
> **Dragging it:** Winter (−6.8 — Jan high 23°F vs. your 30–42°F band) · Culture & arts (−2.1)
> **Closest tradeoff:** Iowa City scores 4 points lower on healthcare depth but 5 higher on winter. If winter mattered 5 points more to you, they'd swap.
> **We can't tell you:** HOA rules, rail noise, neighborhood feel, or how the hospital treats new patients. That's what the deep-research report covers.
> **Coverage:** 21 of 22 criteria scored · 3 flagged medium confidence · data as of Jun 2026

That last two lines are the product's soul. Ship them on every card.

Never use an LLM to generate this. It's arithmetic, it must be reproducible, and a shared link must say the same thing next year.

---

## 5. Data model and data pipeline

### 5.1 The central separation

Your workbook's structural weakness is that `Scorecard` (scores) and `Data - Core` (evidence) are parallel sheets with no enforced link — which is exactly how 100% score coverage sits next to 67% evidence coverage without anyone noticing. The product must make that impossible.

**Every score must be derived from observations, and a score with no observations must be visibly, structurally different from one with them.**

### 5.2 Schema

```
── GEOGRAPHY ──────────────────────────────────────────────────
place
  id, slug, name, display_name
  kind            enum: city | town | cbsa_metro | cbsa_micro | multi_town | region
  country, admin1 (state), admin2 (county), cbsa_code, place_fips
  centroid geography, population, population_vintage
  parent_place_id            -- town → metro
  member_place_ids[]         -- multi_town rows: explicit, not implied by a slash
  is_published, coverage_pct, mean_confidence

basin / climate_division / school_district / hospital_service_area
  -- coarse geographies scored ONCE and joined to many places.
  -- This is the scaling trick: see §5.5.

place_geography_link (place_id, geography_id, geography_kind, overlap_pct)

── CRITERIA ───────────────────────────────────────────────────
theme            id, key, name, description, default_budget_share
criterion
  id, key, name, theme_id
  direction        enum: higher_better | lower_better | banded
  unit, scoring_kind  enum: derived | rubric | hybrid | user_computed
  rubric_anchors   jsonb    -- the Rubric sheet, verbatim, as data
  breakpoints      jsonb    -- raw→score mapping, e.g. housing price bands
  stage            enum: screen | shortlist_only | research_only
  base_confidence  enum, source_class text
  min_geo_level    enum     -- finest geography this criterion is honest at
  is_active, version

criterion_correlation (criterion_a, criterion_b, pearson_r, computed_at)
  -- powers the double-counting warning in the weight UI

── EVIDENCE (append-only) ─────────────────────────────────────
source
  id, name, publisher, url, license, license_permits_redistribution bool
  source_class enum: government | academic | commercial | curated | inferred
  refresh_cadence, last_ingested_at, next_due_at

observation                       -- THE FACT LAYER. Never overwritten.
  id, place_id, criterion_id, source_id
  raw_value numeric, raw_text, unit
  as_of date, ingested_at
  geo_level enum: place | county | cbsa | basin | state | national
  geo_match_quality enum: exact | contained | interpolated | inherited
  method text, pipeline_version

── SCORES (versioned, derived) ────────────────────────────────
score
  id, place_id, criterion_id
  score numeric(3,1), percentile_in_cohort, cohort_key
  confidence enum: high | medium | medium_low | low
  uncertainty_sd numeric          -- drives the band; see §6.4
  derived_from_observation_ids[]  -- NOT NULL for derived criteria. Enforced.
  scoring_method enum: breakpoint | rubric_analyst | rubric_llm_reviewed | inherited
  rationale_md text               -- your Data-Core notes, per cell, structured
  scored_by, scored_at, ruleset_version, dataset_version
  superseded_by score_id

score_override (score_id, analyst_id, new_score, reason_md, created_at)
  -- your "override anything you disagree with" principle, made auditable

── USER ───────────────────────────────────────────────────────
user            id, email, role enum: visitor|free|premium|analyst|admin, created_at
household_profile
  user_id, adults, children_ages[], work_status, budget_band,
  anchor_places[], health_needs_flag bool   -- FLAG ONLY, never details (§11)
scenario                       -- the saved search
  id, owner_id | anon_id, name
  weights jsonb, filters jsonb, tolerance_bands jsonb
  excluded_place_ids[], pinned_place_ids[]
  created_at, updated_at
result_snapshot                -- IMMUTABLE
  id, scenario_id, dataset_version, ruleset_version, computed_at
  ranked jsonb, tiers jsonb, explanations jsonb, share_token
  -- a shared link must mean the same thing in 2029 as it does today

── AI ─────────────────────────────────────────────────────────
research_request
  id, scenario_id, snapshot_id, place_ids[], status, requested_at
  context_package jsonb, model, input_tokens, output_tokens, cost_cents
  human_reviewed_by, human_reviewed_at
research_document
  id, request_id, place_id, sections jsonb, citations jsonb
  claim_verification jsonb, overall_confidence
── FEEDBACK ───────────────────────────────────────────────────
score_dispute (user_id, place_id, criterion_id, direction, note, resolved)
  -- the calibration flywheel; §10
```

### 5.3 The four data classes, made explicit

Your workbook distinguishes these informally in prose. Make them a column.

| Class | `source_class` | Example from your file | Where it can appear | Refresh |
|---|---|---|---|---|
| **Objective national dataset** | `government` | Elevation, Jan mean high, days <0°F, effective property tax, wildfire risk, broadband availability | Screen, any weight | Annual–monthly |
| **Semi-structured / inferred** | `inferred` | Childcare availability from state market-rate surveys; walkability for multi-town rows | Screen, but capped confidence and flagged | Annual |
| **Curated narrative** | `curated` | Your `Data - Water` strengths/vulnerabilities/outlook; the Gelman plume note; the Door County karst caveat | Place pages and AI context — **never a score input** | Event-driven |
| **AI-generated summary** | `ai_generated` | Deep-research report sections | Paid tier only, cited, verified, badged | Per request |

Hard rule: **`inferred` and `ai_generated` can never produce a score that displays as high confidence, and `ai_generated` can never produce a score at all.**

### 5.4 Factor-by-factor: what automates, what doesn't

This table is the feasibility answer for the data layer. All 40 of your columns, classified against national US sources.

| # | Your factor | v1 treatment | Candidate national source | Conf. |
|---|---|---|---|---|
| 1 | Climate resilience (30-yr) | **Decompose — don't ship as one** | NOAA NCEI normals + downscaled projections; but split heat/drought/flood | — |
| 2 | Winter air quality | Derived | EPA AQS winter PM2.5 percentiles (sparse monitors in small towns → interpolate, flag) | Med |
| 3 | Wildfire smoke exposure | Derived | NOAA HMS smoke plume days (satellite, full national coverage) | High |
| 4 | Summer thunderstorm days | Derived | NLDN / NOAA lightning climatology | High |
| 5 | SLC proximity & access | **User-computed** | Routing API + BTS T-100 nonstops | High |
| 6 | Local politics / culture fit | Derived proxy | MIT Election Lab county presidential margin | High |
| 7 | State politics fit | Derived (51 rows) | Trifecta / policy indices | High |
| 8 | Quiet / low traffic | Derived proxy | Density + ACS commute time + BTS national transportation noise map | Med |
| 9 | Housing affordability | Derived | Zillow ZHVI or Redfin Data Center (**check license**), FHFA HPI, ACS median value | High |
| 10 | Cost of living & income tax | Derived | **BEA Regional Price Parities** (official, metro-level, free — better than commercial COL indexes) + state tax tables | High |
| 11 | Property taxes | Derived | Census ACS effective rate by county | High |
| 12 | Retirement income taxation | Derived, **51 rows** | State statutes, hand-updated annually — costs O(states), not O(places) | High |
| 13 | Insurance cost & risk | **Shortlist only** | No clean national premium-by-ZIP exists. Do not fake it. | — |
| 14 | Healthcare access | Derived | CMS Provider of Services + drive-time isochrones to acute care / Level I–II trauma | High |
| 15 | Airport connectivity | Derived | BTS T-100 nonstop destination count + drive time to airport | High |
| 16 | Crime / safety | Derived, **heavily caveated** | FBI NIBRS — coverage gaps and cross-agency comparability are severe. Consider CDC violent-death + property proxy. Flag prominently. | Med-Low |
| 17 | Setting & recreation | Derived proxy | DEM terrain ruggedness + PAD-US protected land within 60 min + OSM trail km + coast/ski proximity | Med-High |
| 18 | Culture & arts | Derived proxy | BLS arts-employment location quotient + Wikidata/OSM venue counts | Med |
| 19 | Education / schools | Derived, **within-state only** | NCES/EDFacts + ACS attainment. Cross-state raw comparison is invalid; use within-state percentile. | Med |
| 20 | Altitude | Derived | DEM. Trivial. | High |
| 21 | Transplant friendliness & inclusive churches | Derived proxy | ACS in-mover share + ARDA congregation census by denomination. **Mostly automatable** — but see the fair-housing flag in §11. | Med |
| 22 | Winter sunshine / darkness | Derived, **split in two** | NREL NSRDB cloud cover **and** daylight hours from latitude — your own `v5.4` note asks for this split | High |
| 23 | Maintenance burden | **Drop** | r = 0.87 with Extreme cold, −0.78 with Snow days. It's a function of other columns. | — |
| 24 | Grandkid visit appeal | **User-computed** | Reframe: "visitability from your anchors" = travel friction + attraction density | Med |
| 25 | Mosquito prevalence | Derived proxy | Climate + NLCD wetland cover + abatement-district presence | Med-Low |
| 26 | Extreme cold | **Merge into winter curve** | NOAA normals, days <0°F | High |
| 27 | Winter warmth | **Merge into winter curve** | NOAA Jan mean max | High |
| 28 | Snow days | Derived (recreation, separate from temperature) | Snowfall normals + ski area drive time | High |
| 29 | Costco proximity | Derived — generalize to "big-box errand access" | POI geocode + drive time; auto-refreshable, unlike your July-2026 hand list | High |
| 30 | Playa / windblown dust | **Regional flag, not a score** | Only your Utah rows are evidenced; your own note says treat the rest as directional | Low |
| 31 | Fire risk | Derived | **USFS Wildfire Risk to Communities** — national, free, excellent. Best available. | High |
| 32 | Summer humidity | Derived (tolerance band) | NOAA Jul–Aug dew point normals | High |
| 33 | Medical quality & specialist depth | Derived | CMS star ratings + COTH academic affiliation + **NPI registry specialist counts per capita** | High |
| 34 | Healthcare job market | **Merge with #33 or drop** | r = 0.96 with #33. Two columns, one signal, double weight. | — |
| 35 | Water stability | **Derived at basin level** (§5.5) | USGS + Reclamation + state water plans + SGMA filings — score ~200 basins, join to 900 places | High |
| 36 | Job market & resilience | Derived | BLS QCEW industry HHI + unemployment trend | Med-High |
| 37 | Broadband | Derived | FCC BDC availability **+ Ookla open speed data** to correct the overstatement your notes flag | Med |
| 38 | Demographics & growth | Derived | Census PEP components of change. Drop the "managed" judgment — it's interpretive and you said so. | High |
| 39 | Walkability & transit | Derived | **EPA Smart Location Database** (national, free) + NTD transit service | High |
| 40 | Childcare & eldercare | **Shortlist only** | Weakest column in your file by your own assessment. State-level data masquerading as local. | — |

**Tally: 30 of 40 have a credible national machine source. 4 merge or drop as redundant. 3 move to the shortlist stage. 2 become user-computed. 1 becomes a regional flag.**

That is a strongly positive feasibility signal, and it reframes the whole effort: **your spreadsheet's cost was manual assembly, not data absence.** The data mostly exists; nobody had built the pipes.

### 5.5 The scaling trick: score at the coarsest honest geography

The reason 900 places is affordable and 4,120 hand-scored cells is not:

| Geography | Count | Criteria scored there | Cost of national coverage |
|---|---|---|---|
| Nation | 1 | — | — |
| State | 51 | Retirement taxation, state politics, income tax | **51 rows, hand-maintainable** |
| Basin | ~200 | **Water stability** | **200 rows, your best column, still hand-researchable** |
| County | ~3,100 | Politics, property tax, crime, childcare | Automated join |
| CBSA | ~940 | COL (BEA RPP), job market, healthcare jobs, culture | Automated join |
| Place | ~900 | Climate, elevation, walkability, broadband, fire, airport, POI | Automated |

Adding your 901st place costs *nothing* on the 51-row and 200-row layers. This is why the water column — the most labor-intensive research in your workbook — is actually the most scalable one: it's basin-level truth, and basins don't multiply when you add cities.

**Corollary and design rule:** `min_geo_level` on every criterion, `geo_level` + `geo_match_quality` on every observation, and automatic confidence downgrade when the observation is coarser than the place. That single mechanism encodes your childcare caveat, your multi-town caveat, and your school-comparability caveat, structurally, forever.

### 5.6 Broader location coverage

| Phase | Coverage | Method |
|---|---|---|
| v1 | ~150 US places — all CBSAs above ~100k plus ~40 curated small towns | Pipelines + curated small-town list |
| Phase 3 | ~900 US places — all metro + micropolitan CBSAs | Same pipelines, zero new criteria work |
| Phase 4 | Sub-metro granularity for the top ~40 metros (your Carlsbad/Encinitas and Albuquerque-NE-Heights problem) | Place-within-metro hierarchy |
| Phase 6 | Canada, then selected EU | Requires a parallel source stack; treat as a **separate product surface**, never a merged leaderboard |

**Kill the multi-town row entirely.** 27% of your rows average two places and hide it behind a slash. In the product, `Ashland` and `Medford` are two `place` rows, optionally grouped for display. Your own note — *"Medford's water position is materially better than Ashland's… split any row you get serious about"* — is the spec.

---

## 6. Scoring methodology

### 6.1 Two scoring families

| Family | Mechanism | Applies to | Auditable? |
|---|---|---|---|
| **Breakpoint-derived** | Piecewise-linear map from raw value → 0–10, breakpoints stored **as data** | ~28 criteria | Fully — "you scored 6 because median price is $482K, and $425–525K = 6" |
| **Rubric** | Anchor descriptions, analyst- or LLM-drafted-then-analyst-approved | ≤4 criteria in v1 | Partially — shows the anchor text and rationale |

Your housing rubric is already the correct pattern. Generalize it to everything and store the breakpoints in the `criterion.breakpoints` JSONB so recalibration is a data edit and a migration, not a code deploy.

### 6.2 Preserving what the rubric model gets right

Four things in your workbook are genuinely better than what most products do. Keep all four, literally:

1. **Named anchors at each level.** *"10 = academic medical center with full subspecialty coverage. 5 = competent community hospital, specialists require travel."* Ship this text in the UI on hover. It's what makes a 1–10 mean anything.
2. **Per-criterion source class and confidence.** Already in your Rubric sheet. Promote to columns and display as badges.
3. **Explicit inverted-direction handling.** Your legend states higher = better on every column *including* the inverted ones. Enforce in the schema with `direction`, so an inverted criterion can't silently flip.
4. **Visible dropped criteria.** *"Scoring them would have meant generating plausible numbers and attaching whichever citation looked closest — worse than an honest blank."* Put that sentence, or one like it, on the product's methodology page. It is your best marketing copy and you already wrote it.

### 6.3 Normalization

| Method | Spread across your 103 places | Median adjacent gap |
|---|---|---|
| Raw 1–10 (current) | 18.1 | 0.092 |
| Z-score | 15.3 | 0.082 |
| **Within-cohort percentile** | **28.5** | **0.144** |

Percentile normalization gives ~60% more discrimination. Recommendation: **compute and store both.** Absolute 0–10 (rubric-anchored, comparable across cohorts and over time) drives the math; percentile-within-cohort drives display ("7/10 — 84th percentile among US metros over 100k"). Cohort must be explicit and user-visible, because "84th percentile" is meaningless without it.

### 6.4 Missing data

**Never impute silently.** Three sanctioned behaviors:

| Situation | Behavior |
|---|---|
| Criterion missing, low user weight | Drop it, renormalize the user's weights across what remains, note it in the coverage line |
| Criterion missing, high user weight (>10% of budget) | Place is shown but **cannot enter the top tier**; badged "we can't score the thing you care most about here" |
| Criterion is a hard filter and is missing | Place is excluded from the pass list, but shown in a separate "unknown — couldn't verify" bucket. Never silently dropped. |

Plus a hard rule: **a place cannot appear in the top tier if scored coverage is below 85% of the user's weighted mass.** This structurally prevents the failure your workbook has, where a thinly-evidenced row can outrank a well-evidenced one purely because both look complete.

### 6.5 Stale data

`as_of` on every observation, per-criterion `max_age`, and automatic confidence decay past it. Display the vintage on every number that has one (your `Data - Core` already effectively does this with "approx, 2026"). Housing and job-market data go stale in months; elevation never does. A single global "last updated" banner is a lie — do it per-cell.

### 6.6 Low-confidence criteria → score bands, not point scores

This is how you turn Finding 2 from a fatal flaw into a feature.

Assign an uncertainty SD by confidence level (high ±0.4, medium ±0.8, medium-low ±1.3, low ±2.0), then Monte Carlo the weighted score ~2,000 times per scenario — trivially fast in-browser for 900 places. Output an 80% interval per place.

Then: **tiers are formed by non-overlapping bands.** Places whose intervals overlap are in the same tier and are ordered alphabetically, or by the user's single highest-weighted criterion — never by hundredths of a point.

On your data with your weights, this would produce roughly:

| Tier | Approx. content |
|---|---|
| Strong fit | ~8–12 places (everything currently within ~3 points of the top) |
| Good fit | ~20 |
| Mixed | ~45 |
| Poor fit | ~30 |

Which is a *truthful* summary of what your model actually knows, and — critically — is still decision-useful. "Twelve places screen strongly for you, here's what separates them" is a better product than a fake #1.

### 6.7 Collinearity

84 of 780 factor pairs in your workbook have |r| > 0.5. PCA says **9 components explain 80% of variance and 13 explain 90%** — so your 40 factors carry roughly 9–13 independent signals. Weighting 40 things independently is weighting 10 things, some of them four times.

Three mitigations, all v1:

1. **Theme-level budget.** Users allocate to ~10 themes; the app distributes within a theme. Correlated criteria live in the same theme, so their combined influence is bounded by the theme's budget. This is the structural fix.
2. **Redundancy warning.** Precompute `criterion_correlation`; when a user's advanced-panel weights concentrate on a correlated pair, say so: *"Medical quality and healthcare employment move together (r = 0.96). Weighting both mostly double-counts one thing."*
3. **Merge the worst offenders before launch.** #33/#34 (r = 0.96) merge. #26/#27 (r = 0.91) merge into the winter curve. #23 drops. #1 decomposes so it stops secretly containing #32 — a problem your own `v5.4` note flags and declines to fix silently, correctly.

### 6.8 What users see

| Element | Show? | Where |
|---|---|---|
| Tier (Strong / Good / Mixed / Poor) | **Yes** | Primary |
| Score band (e.g. 71–78) | **Yes** | Secondary |
| Point score to 0.1 | **No** | Never — this is Finding 2 |
| Integer rank out of 900 | **No** | Never |
| Rank within *your shortlist* of ≤8 | Yes | Comparison view only |
| Per-criterion 0–10 | Yes | Place detail |
| Percentile within cohort | Yes | Place detail, alongside the 0–10 |
| Confidence badge per criterion | **Yes** | Everywhere a score appears |
| Data vintage | **Yes** | Per criterion |
| Contribution decomposition | **Yes** | Every result card |
| Raw source value + link | Yes | Expandable on place detail |

---

## 7. AI handoff design

### 7.1 The boundary

| Deterministic — always | LLM — never touches the above |
|---|---|
| All scores, all normalization | Explaining a deterministic result in prose |
| All filters and exclusions | Researching the shortlist-only criteria |
| Weighted aggregation, tiering, banding | Answering the user's free-text questions |
| Contribution decomposition | Drafting neighborhood-level guidance |
| Ranking within the shortlist | Proposing rubric breakpoints **for analyst approval** |
| Anything appearing on a shared snapshot | Triaging user score disputes |

**Non-negotiable: an LLM must never produce, modify, or reorder a score.** If it does, the product loses reproducibility, auditability, and the ability to say "here's exactly why" — which is the entire differentiator. It also becomes impossible to defend when a user relocates and the answer was wrong.

### 7.2 The handoff, in product terms

```
User has a shortlist of 3–5 places in a saved scenario
        ↓
"Get the deep research"  →  Stripe Checkout ($99)
        ↓
Scoping step (30 seconds, high value, do not skip):
  · Confirm the shortlist
  · Pick focus areas from the unscoreable list
    ☑ HOA & home-project restrictions   ☑ Noise (rail, flight paths, industrial)
    ☑ Neighborhood-level feel            ☐ Short-term rental intensity
    ☑ Disaster preparedness              ☐ Business/licensing environment
  · Free text: "anything specific?"
        ↓
Async job (10–25 min). Email on completion. Progress page shows live
per-place status — this is itself a demo of Elevrics' orchestration.
        ↓
Delivered: per-place report + a cross-place synthesis, every factual
claim cited, inferences labeled as inferences, confidence per section,
"we could not verify X" stated plainly.
        ↓
First 100 reports: human skim before delivery. Non-negotiable (§10).
```

The scoping step matters commercially as well as technically: it's where the user tells you what the *next* version of the criteria universe should contain.

### 7.3 Context package

Send the model everything it needs to be specific and nothing that identifies the user.

```jsonc
{
  "dataset_version": "2026.07.1",
  "ruleset_version": "3",
  "household": {                       // generalized, non-identifying
    "adults": 2, "children_ages": [],
    "life_stage": "pre_retirement",
    "work_status": "one_remote_one_retired",
    "budget_band": "400_600k",
    "anchors": [{"label": "adult children", "metro": "Salt Lake City, UT"}],
    "accessibility_needs": true        // FLAG ONLY — never the diagnosis
  },
  "preferences": {
    "theme_budget": {"healthcare": 22, "climate_water": 20, "cost": 18, ...},
    "hard_filters": [
      {"criterion": "medical_specialist_depth", "op": ">=", "value": 7},
      {"criterion": "home_price_median", "op": "<=", "value": 600000}
    ],
    "tolerance_bands": {"winter_jan_high_f": {"ideal": [30,42], "tol": 8}}
  },
  "shortlist": [
    {
      "place": "Rochester, MN", "tier": "strong", "band": [71,78],
      "coverage_pct": 95, "mean_confidence": "high",
      "scores": [
        {"criterion":"medical_specialist_depth","score":10,"percentile":0.99,
         "raw":{"value":"Mayo Clinic; 1,240 specialists/100k","as_of":"2026-03"},
         "confidence":"high","source":"CMS POS + NPI registry",
         "contribution": 8.1}
        // ... every criterion, with raw value and provenance
      ],
      "top_drags": ["winter_jan_high_f", "culture_arts"]
    }
  ],
  "rejected": [                         // WHY things were dropped — high signal
    {"place":"Santa Fe, NM","reason":"hard_filter","detail":"water_security=2 (Low tier); Rio Grande Compact debt limit risk"},
    {"place":"St. George, UT","reason":"hard_filter","detail":"climate/water; 104°F July normal"}
  ],
  "unresolved_tradeoffs": [             // computed, not guessed
    {"between":["Rochester, MN","Iowa City, IA"],
     "axis":"medical_depth vs winter_severity",
     "note":"user weighted both in top 3; the shortlist cannot satisfy both"}
  ],
  "known_unscored": [                   // literally your dropped-11 list
    "hoa_restrictions","noise_rail_flight_industrial","housing_stock_type",
    "community_engagement","infrastructure_quality","disaster_preparedness",
    "aging_accessibility","str_intensity","grocery_access",
    "business_friendliness","long_term_re_trends"
  ],
  "user_questions": ["Is there a functioning Episcopal parish?",
                     "How bad is the airport in winter?"],
  "instructions": {
    "cite_every_factual_claim": true,
    "label_inference_explicitly": true,
    "state_when_unverifiable": true,
    "do_not_recompute_or_reorder_scores": true
  }
}
```

Two elements here are unusual and both come straight from your workbook:

- **`rejected` with reasons.** Telling the model *"Santa Fe was cut for water"* prevents it from cheerfully recommending Santa Fe and lets it address the cut directly if the user asks. Your `Notes - v7` water findings are exactly this kind of high-signal negative information.
- **`known_unscored`.** The model is told precisely what the deterministic layer could not know, which is its actual job description. Your dropped-11 list is the research brief.

### 7.4 Pipeline and guardrails

```
1. Plan       → per place, decompose focus areas into search tasks
2. Research   → parallel, web-search-grounded, structured claims:
                {claim, evidence_quote, url, published_date,
                 confidence, is_inference}
3. Verify     → SEPARATE adversarial pass, fresh context, prompted to
                REFUTE. Drops any claim whose citation doesn't support it.
                (Cheap, and it's the difference between credible and not.)
4. Synthesize → prose from surviving claims only
5. Human skim → analyst review, first 100 reports minimum
6. Deliver    → cited, confidence-badged, with an explicit
                "what we could not determine" section
```

Guardrails: no claim without a citation or an explicit inference label; no recommendation to buy, move, or invest; no tax, legal, medical, or immigration advice, ever, with a hard refusal path; every report shows its model, date, and dataset version.

**Cost:** a 5-place run with search and verification runs roughly 300k–800k tokens. At current Claude pricing that's single-digit to low-double-digit dollars, plus the human skim. Price at **$99** and unit economics survive a retry, a verification pass, and 15 minutes of analyst time. Do not price below $49; you'll be underwater the first time a report needs redoing.

---

## 8. Authentication and accounts

### 8.1 Anonymous-first

The questionnaire must be completable and results viewable with **no account**. Gating the funnel before the payoff is the most common and most expensive mistake in this product category.

| Role | Can do | Persists |
|---|---|---|
| **Anonymous visitor** | Full questionnaire, full results, full place detail, one shareable snapshot link | `anon_id` cookie, 30 days server-side; scenario claimable on later signup |
| **Free registered** | Unlimited saved scenarios, named household profiles (his/hers/joint), scenario comparison, revisit with refreshed data, alerts when a shortlisted place's score materially changes | Indefinite |
| **Premium (report purchaser)** | Everything above + purchased reports, exports (PDF/CSV), report re-runs at a discount | Indefinite; reports permanent |
| **Analyst** | Score overrides with mandatory reason, dispute queue, breakpoint calibration, pipeline run status, unpublished-place preview | Full audit trail |
| **Admin** | User management, dataset version promotion, pricing, feature flags | — |

Multiple household scenarios matter more than they look: the highest-engagement behavior in this category is two partners each building a scenario and then comparing. Build "compare two scenarios side by side" in v1 — it's cheap and it's the sharing mechanic.

### 8.2 Persist vs. ephemeral

| Persist | Ephemeral / never stored |
|---|---|
| Scenarios (weights, filters, tolerances, exclusions) | Raw questionnaire keystrokes |
| Immutable result snapshots pinned to a dataset version | Intermediate scoring computations (recomputable) |
| Household profile at **band** granularity | Exact income, exact ages of adults, precise addresses |
| Accessibility/health-need **boolean flag** | Any health condition detail — do not collect it (§11) |
| Purchased reports | Anonymous sessions past 30 days |
| Score disputes | — |

Snapshot immutability is a correctness requirement, not a nicety: a shared link whose meaning changes when the dataset updates is a broken promise and, if someone made a decision on it, a liability.

---

## 9. MVP recommendation

### 9.1 Scope

| Dimension | v1 | Explicitly not v1 |
|---|---|---|
| **Geography** | US only. ~150 places: all CBSAs ≥ 100k population, plus ~40 curated small towns (from your own list — that's the differentiated part) | International, sub-metro neighborhoods, Canada |
| **Criteria** | **22**, in 10 themes. All meet the ≥95%-national-coverage rule. Zero hand-scored. | The other 18; the dropped 11 (they're the paid tier) |
| **Sources** | ~14 pipelines (NOAA, Census/ACS, BEA RPP, BLS QCEW, CMS+NPI, USFS wildfire, EPA SLD, EPA AQS, FCC+Ookla, MIT Election Lab, PAD-US/DEM, BTS T-100, Zillow-or-Redfin, state tax tables) | The remaining ~8 |
| **Manual** | Basin water tiers (~60 basins covering the 150 places); state retirement-tax table (51); curated small-town list; breakpoint calibration; rubric anchor text | Everything else |
| **Questionnaire** | Blocks A–D (~14 questions, <4 min). Tolerance curves for winter + summer + city size only | MaxDiff, adaptive branching, block F depth |
| **Results** | 4 tiers with bands, contribution decomposition, place detail with per-criterion score + raw + source + confidence, compare up to 3, share link | Ranks, maps, scenario diffing, alerts |
| **Accounts** | Anonymous + free registered + magic link | Premium tier, teams |
| **AI** | **One paid report SKU**, 3–5 places, 4 focus areas, human-reviewed | Chat, agents, self-serve prompting |
| **Payments** | Stripe Checkout, $99 one-time | Subscriptions, credits |

### 9.2 What v1 must get conspicuously right

1. The tier/band display — not ranks.
2. The confidence badge and vintage on every displayed number.
3. The "what we can't tell you" line on every result card.
4. The methodology page, in your workbook's voice, including the dropped list and why.
5. Sub-4-minute questionnaire with results before the account wall.

### 9.3 What to deliberately leave out

Maps (expensive, low decision value at screen stage) · school-by-school data (comparability trap) · rent data (freshness burden) · job listings (staleness is instant) · a chatbot (undermines the deterministic promise) · social features · a public global leaderboard (reintroduces false precision by the back door) · anything international.

### 9.4 Build estimate

| Workstream | Solo founder | With one contractor |
|---|---|---|
| Data pipelines (14 sources, dbt, versioned bundle) | 6–9 weeks | 4–5 weeks |
| Place hierarchy + geo joins + basin layer | 2 weeks | 1.5 weeks |
| Scoring engine + breakpoint calibration | 2–3 weeks | 2 weeks |
| Questionnaire + results UI | 4–5 weeks | 3 weeks |
| Accounts, snapshots, sharing, Stripe | 2 weeks | 1.5 weeks |
| AI research pipeline + verification + review tooling | 3–4 weeks | 3 weeks |
| Methodology pages, SEO place pages, polish | 2 weeks | 1.5 weeks |
| **Total** | **21–29 weeks (~5–7 months)** | **16–19 weeks (~4 months)** |

Aggressive alternative: **12 weeks** by cutting to 8 sources, 14 criteria, 100 places, no paid tier — a validation instrument rather than a product. Reasonable if you want a market signal before committing the full build; see the Phase 1 gate below.

---

## 10. Phased roadmap

| Phase | Duration | Ship | Gate — validation question | Kill / pivot criterion |
|---|---|---|---|---|
| **0. Prototype** | 3 wks | Your 103 places, hand-loaded. Real questionnaire, real tier UI, no pipelines. Show 20 people in persona 1. | *Does the tier/band presentation feel more trustworthy than a ranked list, or just vaguer?* | If users demand ranks and reject bands, the honesty positioning fails and the whole strategy needs rethinking. **This is the cheapest, most important test in the plan — run it first.** |
| **1. Alpha** | 8 wks | 8 pipelines, 100 places, 14 criteria. Private, invite-only, ~50 users. | *Do people complete the questionnaire? Does the shortlist contain places they hadn't considered?* Target: >60% completion, >50% report ≥1 genuine surprise. | <40% completion → the elicitation design is wrong, not the data. |
| **2. Beta** | 8 wks | 14 pipelines, 150 places, 22 criteria. Accounts, sharing, public. **Presell the report at $99 before building it** — a waitlist with a real card capture. | *Will anyone pay?* Target: ≥3% of completers pre-order. | <1% → the free tool is a lead magnet only; abandon the consumer paid tier and pivot the revenue to B2B. |
| **3. Launch + AI tier** | 6 wks | Deep-research pipeline, verification, human review, delivery. Methodology page. Content/SEO push. | *Do reports get delivered without embarrassment? Refund rate?* Target: <5% refunds, zero uncited factual claims shipped. | >15% refunds → the AI layer isn't ready; keep it in manual-assisted mode longer. |
| **4. Depth** | 12 wks | 900 places (same pipelines). MaxDiff elicitation. Scenario comparison. Alerts. Sub-metro for top 40 metros. Calibration flywheel from disputes. | *Does 6× coverage improve outcomes or just add noise?* | If shortlist quality doesn't improve, stop expanding coverage and expand *depth* instead. |
| **5. B2B / white-label** | ongoing | Engine as an API. Corporate mobility, RIA/wealth-advisor, brokerage partnerships. | *Will an enterprise pay 20–50× a consumer report for the same engine with their criteria?* | This is where the real revenue is; the consumer product's job is to make this conversation easy. |
| **6. International** | later | Canada first, as a **separate surface**. | *Can you source 60% of criteria at comparable quality?* | If not, don't. Your own notes show what happens when anchors don't transfer. |

The Phase 2 presell gate is the most valuable commercial decision point in the plan: it costs one week and it tells you whether you're building a business or a very good marketing asset. Both are legitimate outcomes; you just want to know which one before Phase 3.

---

## 11. Operational burden, business model, risks

### 11.1 Where maintenance concentrates

| Area | Steady-state load | Notes |
|---|---|---|
| **Pipeline maintenance** | **8–15 hrs/mo** | The dominant cost. Sources change schemas, URLs, and definitions without warning. Every pipeline needs a freshness monitor and a schema assertion; treat a silent pipeline failure as a Sev-1, because stale-but-plausible data is worse than missing data. |
| Breakpoint recalibration | 4–8 hrs/quarter | Adding places shifts distributions, which shifts percentiles, which shifts every score. Needs a diff-review tool: "this release moved 240 scores; here are the 12 that moved >1 point." |
| **Basin water research** | 20–30 hrs/yr | Your best column. Basin-level = O(200), so this stays affordable. Budget a real annual refresh; the 2026 Colorado River guidelines expiry alone will invalidate a chunk of it. |
| State tax table | 8 hrs/yr | O(51). Cheap. |
| Score disputes / QA | 2–5 hrs/wk once traffic exists | Also your best free calibration signal — route disputes into the analyst queue and treat volume per criterion as a confidence signal. |
| Support | 3–6 hrs/wk | Mostly "why isn't my town listed" and "your crime score is wrong." |
| **AI cost** | Variable, but bounded | ~$5–15 per report against a $99 price. Fine. The risk isn't unit cost, it's an unbounded free tier — never expose LLM calls to anonymous users. |
| **Human report review** | **~20 min/report** | The one cost that doesn't scale. At 50 reports/mo that's 17 hrs/mo. Plan to relax to sampling (review 1 in 5) only after 100 clean reports, and never drop it to zero. |
| Legal / disclaimer | 6–10 hrs up front, then low | See §11.3. |

**The two hardest long-term operational problems:**

1. **Silent pipeline degradation.** A source changes its definition, your numbers stay plausible, and hundreds of scores are quietly wrong for six months. Mitigation: assert on distribution shape, not just non-null; alert on any release that moves >N scores by >1 point; keep the observation layer append-only so you can always reconstruct what a score was derived from.
2. **Calibration drift as coverage grows.** This already happened in your workbook (69 → 103 rows, evidence coverage fell to 67%). The structural defense is the `derived_from_observation_ids` NOT NULL constraint plus the coverage badge — make it *impossible* to ship a score with no evidence, and *visible* when a place is thin.

### 11.2 Business model

| Model | Fit | Verdict |
|---|---|---|
| Free lead magnet | Necessary | **Yes — the free screen is the whole funnel** |
| **One-time report purchase, $99** | Excellent | **Yes — the primary v1 revenue** |
| Freemium (paid saved scenarios) | Poor | No — gating saves kills the flywheel for pennies |
| Subscription | Poor | **No.** Once-a-decade decision. If you want recurring, sell a **3-month "active search pass"** ($29) — a bounded pass, not a subscription with a churn cliff. |
| Advisor / referral fees | **Dangerous** | **No, with one exception.** Mortgage/agent referral fees are large but they corrupt the rankings, and credibility is the entire asset. If ever: post-decision services only, prominently disclosed, and structurally incapable of affecting any score. Write that constraint into the schema, not just the policy. |
| **B2B / white-label** | **Excellent** | **Yes — Phase 5, and probably where the money actually is.** Corporate mobility teams, RIAs advising retirees, remote-first employers. Same engine, their criteria, their brand. |

Recommended sequence: free screen → $99 report (validate at Phase 2 by presell) → B2B licensing → optional active-search pass. Total consumer revenue will likely be modest; treat it as validation and as proof-of-competence for the B2B conversation, which is Elevrics' actual business.

### 11.3 Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **False precision** | **High** — measured: 0.09-point median rank gaps | Tiers and bands, never ranks; confidence badges; Monte Carlo intervals; no 0.1-precision display anywhere |
| **User over-trust** | **High** | "This is a screen, not an answer" as persistent framing; a mandatory "what we can't tell you" block on every card; the methodology page front and center |
| **Data incompleteness** | Medium | Coverage % per place; top-tier eligibility requires ≥85% weighted coverage; unknowns shown, never silently dropped |
| **Crime data comparability** | Medium-High | FBI NIBRS has real coverage gaps and cross-agency inconsistency. Caveat prominently or use it only as a broad band. Do not present a precise crime score. |
| **Housing / job data freshness** | Medium | Per-cell vintage; monthly refresh for housing; confidence decay past `max_age` |
| **Commercial data licensing** | Medium | Verify redistribution rights before shipping any Zillow/Redfin-derived value. Prefer FHFA HPI + ACS where a license is ambiguous. Store `license_permits_redistribution` on `source` and enforce it in the publish step. |
| **Fair-housing / steering adjacency** | **Medium-High — flag for counsel** | A US relocation tool scoring "local politics/culture fit," "transplant friendliness & inclusive churches," and "demographics" sits near Fair Housing Act steering concerns. You are probably not a housing provider or broker, so §3604 likely doesn't apply directly — **but** the exposure becomes real the moment you partner with a brokerage or take referral fees, and the reputational risk exists regardless. Mitigations: never score on protected-class composition; source political criteria to published voting records and say so; avoid "people like you live here" framing entirely; get counsel before any real-estate partnership. Not legal advice — get a lawyer on this one specifically. |
| **Privacy / GDPR** | Medium | Collect bands not values; never collect health details (boolean flag only); keep the AI context package non-identifying; standard DSAR path if you accept EU traffic |
| **International complexity** | Medium | Defer entirely. Your own notes document three anchor sets that don't transfer. |
| **AI hallucination in reports** | **High** | Citation-required structured claims; separate adversarial verification pass; human review on the first 100 and sampled thereafter; explicit "could not verify" section; never let AI touch scores |
| **Liability from a bad move** | Medium | Clear terms: informational screening tool, not professional advice; hard refusal on tax/legal/medical/immigration questions; no "recommendation" language, only "screens well against your stated priorities" |
| **Maintenance abandonment** | **High, and underrated** | The realistic failure mode is not that it doesn't work — it's that pipelines rot in month 14. Budget the 8–15 hrs/mo honestly, or scope to fewer sources you'll actually maintain. |

---

## 12. Final recommendation

**Build it. Build it as a free public screen plus a paid AI shortlist-research report. US-only, ~150 places, 22 machine-derived criteria, tiers instead of ranks, shipped in about four to six months.**

The three things that make this a "yes" rather than a "maybe":

1. **The data is more automatable than the spreadsheet implies.** 30 of your 40 factors have a credible national machine source. Your cost was manual assembly, not data absence. And because many criteria live at state, basin, or county level, coverage scales far better than the 4,120-hand-scored-cells experience suggests.
2. **The honest-uncertainty posture is the differentiator, and you've already written it.** Every competitor is a listicle or a black box. Your workbook's *"a sourced-looking 7 invites trust an obvious placeholder does not"* is a product thesis. Nobody else in this category will say that out loud, and saying it is what makes the free tier worth linking to and the paid tier worth buying.
3. **The dropped 11 criteria are the business model.** The clean boundary between "what a dataset can know" and "what only research can know" gives you a free tier that's genuinely useful, a paid tier that's genuinely necessary, and a demo of Elevrics' AI engineering that's genuinely hard to fake.

The three things you must not do:

1. **Do not ship 40 sliders.** Measured on your own data, they don't change the answer (r = 0.99 vs. flat weighting), and users will notice. Scarce budget across ~10 themes, hard filters first.
2. **Do not ship ranks or 0.1-point scores.** Your #1 and #2 are tied, eight places sit within one analyst's single-point disagreement of the top, and the median gap between adjacent ranks is 0.092 points. Tiers with bands.
3. **Do not hand-score anything at scale.** Your evidence layer already fell to 67% coverage between v5 and v7. Enforce `derived_from_observation_ids` at the schema level so that failure mode becomes impossible rather than merely regrettable.

**Start with the three-week Phase 0 prototype** — your existing 103 rows, hand-loaded, real questionnaire, real tier UI, no pipelines — and put it in front of twenty people in persona 1. The question it answers is the one that decides everything downstream: *does an honest band read as trustworthy, or does it read as vague?* If it reads as trustworthy, you have a real product and a real Elevrics showcase. If it reads as vague, you've spent three weeks instead of six months learning that the market wants the confident lie — and you can decide whether that's a business you want.

---

## Appendix — method

All figures computed directly from `relocation_scorecard_jared.xlsx` (openpyxl + numpy):

- **Score reproduction:** `SUMPRODUCT(D:AQ, $D$4:$AQ$4) / (SUM($D$4:$AQ$4)*10) * 100`, matching the workbook's own formula. 103 location rows, 40 factor columns, 4,120 cells, zero missing.
- **Weight sensitivity:** 2,000 Monte Carlo draws applying lognormal jitter (σ = 0.20 and 0.50) to the weight vector; reported as mean absolute rank displacement and mean top-10 set overlap.
- **Single-edit sensitivity:** every one of the 4,120 cells incremented by 1 (capped at 10) independently; rank displacement recorded for the affected row.
- **Persona weightings:** 8 named factors set to weight 8, all others to 0.25 (and a second run at 1.0 / 0.0), overlap measured against the baseline top 10.
- **Collinearity:** Pearson r over all 780 factor pairs; PCA on z-scored factors via SVD.
- **Filters:** conjunctive thresholds applied to raw 1–10 scores, survivor counts reported.
- **Evidence coverage:** non-empty cell counts per column on `Data - Core` and `Data - Lifestyle`, against 103 named location rows.

Analysis scripts are reproducible from the workbook; no external data was used.
