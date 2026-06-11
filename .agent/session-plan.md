# CKC Comparison Expansion Session Plan

Status: active.

Purpose: expand the M2 route comparison beyond `route.direct_smt` and
`route.single_ir` across multiple Codex sessions while keeping each session
bounded, verifiable, and easy for a fresh agent to resume.

Selection protocol:
- `$session-prompt <TASK>` uses the explicit task text and does not consume this
  queue unless the task says to do so.
- `$session-prompt` with no task text must select the first queue item whose
  `status` is not `done`, then execute that item as the session task.
- At session start, change the selected item from `pending` to `in_progress`
  unless it already has that status.
- Mark an item `done` only after every listed gate passes. If work is partial,
  leave it `in_progress` and add a dated progress note under that item. If work
  cannot proceed without user input, set `status: blocked` and record the exact
  blocker.
- When every item is `done`, no-argument `$session-prompt` should report that
  this comparison expansion plan is complete and ask for a new task before
  changing files.

Global constraints:
- Preserve current M2 claims unless a later item deliberately changes the
  measured experiment. The existing R3 null result for admitted lift remains
  valid until regenerated evidence says otherwise.
- Keep route prompts framed as hospital CDS knowledge-base maintenance/import
  tickets. Model prompts should not expose route IDs, benchmark labels, answer
  payloads, or measurement mechanics.
- Keep raw rows visible before rankings. Do not replace exact numerator/
  denominator metrics with rounded summaries.
- Regenerate manuscript figures after run/report behavior changes.

## Queue

### C1 Route-Matrix Harness Generalization
status: done

Intent: remove the two-route assumptions so the harness can compare any
registry-declared route set before new route behavior is added.

Deliverables:
- Refactor `tools/build-run.mjs` metrics/report/report-ja/verification logic so
  `routeIds` from `registry/experiments.json` can contain more than
  `route.direct_smt` and `route.single_ir`.
- Replace the current fixed `direct_smt` versus `single_ir` lift table with a
  route-matrix comparison artifact that still identifies `route.direct_smt` as
  the baseline.
- Generalize route target summaries so compiled-target routes are summarized per
  route instead of as a single `route.single_ir` artifact.
- Keep current `exp.m2_lift` behavior byte-stable where practical; if hashes
  change, document why in the report or memory.

Gate:
- `npm run verify:recorded`
- `npm run build:figures`
- `npm run verify:figures`

### C2 Route Registry And Experiment Scaffold
status: done

Intent: register the comparison expansion without requiring every route to be
implemented in the same session.

Deliverables:
- Add route registry entries for `route.stacked_ir`, `route.ir_hop_chain`, and
  `route.ckc_layered` with concise shape/runtime/schema notes.
- Add `exp.m3_routes` as a frozen route-comparison experiment that includes the
  M2 pair plus the three new route IDs, reusing current M2 groups until fixture
  expansion lands.
- Teach the run tool to select `exp.m2_lift` by default while allowing
  `exp.m3_routes` through a CLI flag or small explicit configuration path.
- Unsupported registered routes must fail closed with clear diagnostics unless
  an explicit scaffold mode is used; do not silently score fabricated output.

Gate:
- `npm run verify:recorded`
- A direct command proving the default experiment is still `exp.m2_lift`
- A direct command proving `exp.m3_routes` loads and reports unimplemented
  routes as closed/scaffolded rather than fabricated measurements

### C3 Stacked-IR Route
status: done

Intent: add the first additional route: one model output that fills a compact
stack of existing IR-shaped forms before deterministic compilation.

Deliverables:
- Define a minimal stacked JSON contract, for example
  `source_frame -> rule_row -> route_rule_ir.v0`, with schema validation.
- Implement `route.stacked_ir` live prompting, parsing, deterministic bridge,
  compiled target emission, diagnostics, prompt catalog provenance, and raw-row
  scoring.
- Add route-specific residual diagnostics that distinguish schema, grounding,
  bridge, and compiled-target failures.
- Update report and figures to include the third route without special casing.

Gate:
- `npm run verify`
- `npm run build:figures`
- `npm run verify:figures`

### C4 IR Hop-Chain Route
status: done

Intent: test whether several short constrained hops outperform one long route.

Deliverables:
- Implement `route.ir_hop_chain` as adjacent, deliberately small JSON hops, each
  with its own prompt hash, response hash, validation, and bridge diagnostics.
- Record hop-level model calls in `model_io`, prompt catalog, and route target
  lineage without hiding the aggregate route row.
- Ensure live call counts, replay manifests, and verification assertions account
  for multi-call routes.
- Compare hop-chain metrics against direct SMT, single IR, and stacked IR using
  the generalized route matrix.

Gate:
- `npm run verify`
- `npm run build:figures`
- `npm run verify:figures`

### C5 CKC-Layered Route
status: done

Intent: add the route that asks the model for CKC-native stages before the
deterministic compiler takes over.

Deliverables:
- Implement `route.ckc_layered` with stage outputs aligned to the existing CKC
  fixture spine: segment-like spans, statement-like normalized facts, and
  rule-like route IR.
- Reuse existing deterministic CKC pipeline helpers where that reduces
  duplication; keep route-specific model outputs isolated in route artifacts.
- Add stage-level diagnostics and lineage from source excerpts to compiled SMT.
- Include `route.ckc_layered` in the route-matrix report and figures.

Gate:
- `npm run verify`
- `npm run build:figures`
- `npm run verify:figures`

### C6 M3 Fixture And Mutation Expansion
status: pending

Intent: make the route comparison less fixture-bound by adding reuse pressure
and metamorphic variants.

Deliverables:
- Add 4-6 synthetic fixture documents sharing populations/actions/conditions
  across documents, plus deterministic metamorphic variants of current fixtures.
- Extend `corpus/fixtures/m1_fixture_semantics.json`,
  `registry/corpora.json`, `registry/experiments.json`, and
  `corpus/gold/m1_expected.json` with threshold-conflict, factual-conflict,
  null, and terminology-incoherence cases where supported by the toy schema.
- Keep every new gold outcome source-derived and auditable from quoted spans.
- Update reports to distinguish original M1/M2 groups, M2 holdout, and M3
  expanded groups.

Gate:
- `npm run verify`
- A direct JSON audit command proving every `exp.m3_routes` group has gold,
  fixture semantics, and source paths
- `npm run build:figures`
- `npm run verify:figures`

### C7 Deterministic Pipeline Comparison
status: pending

Intent: add the M3 claim-1 comparison between the layered pipeline and a direct
rule-to-SMT deterministic baseline.

Deliverables:
- Implement or scaffold `pipe.direct_rule_to_smt` and `exp.m3_compare` without
  weakening the existing layered M1 spine.
- Emit `candidate_diff.json` comparing segment, binding, rule, assertion,
  verdict, and metric levels across pipelines.
- Add component reuse/compactness artifacts where evidence exists; if a full
  component store is too large, leave explicit residuals instead of implying it
  is complete.
- Report exact layered-minus-direct deltas separately from model-route deltas.

Gate:
- `npm run verify`
- Direct JSON parse checks for `candidate_diff.json` and any reuse/compactness
  artifacts emitted
- `npm run build:figures`
- `npm run verify:figures`

### C8 Final Ranking And Manuscript Evidence Pass
status: pending

Intent: turn the expanded comparison into manuscript-ready evidence without
overclaiming.

Deliverables:
- Emit `ranking.csv` and `score_breakdown.json` from raw rows, with direct SMT
  kept as the baseline and all route/pipeline rankings traceable to exact
  ratios.
- Update manuscript figures and captions so they show all compared routes and
  any deterministic pipeline comparison.
- Ensure English and Japanese reports state whether the result is admitted lift,
  target-syntax lift only, or a null result.
- Run a structured self-review for hallucinated claims, prompt leakage,
  unsupported clinical wording, and stale route-specific assumptions.

Gate:
- `npm run verify`
- `npm run build:figures`
- `npm run verify:figures`
- A direct command proving `ranking.csv` and `score_breakdown.json` are present
  and parseable
