# CKC Realism Session Plan

Status: archived; all queued items are complete. Current work should use explicit `$session-prompt <TASK>` requests and the manuscript-figure artifacts under `figures/manuscript/`.

Purpose: historical R1-R3 queue that reduced fixture cheating in the current one-shot CKC research harness.

Selection protocol:
- `$session-prompt` with no task text now asks the user for a task before changing files.
- These completed items remain only as historical implementation context.
- Mark an item `done` only after its gate passes. Leave it `pending` when work is incomplete, blocked, or needs user input.
- When every queue item is `done`, `$session-prompt` reports that this realism plan is complete and changes nothing.

## Queue

### R1 Data-Driven Fixture Spine
status: done

Intent: remove the most brittle fixture-specific semantics from `tools/build-run.mjs` without changing the current visible result.

Deliverables:
- Move fixture regions, groups, expected outcomes, terminology bindings, and rule specs into committed JSON artifacts under `corpus/` or `registry/`.
- Refactor `tools/build-run.mjs` so extract/segment/normalize/assemble/compile reads those artifacts instead of branching on `a`, `b`, or `control` for semantic content.
- Add a generated realism audit artifact that classifies each pipeline surface as `data_driven`, `fixture_authored`, `prompt_scaffolded`, or `hardcoded`.
- Render the realism audit in reports without weakening the no-clinical-claim wording.

Gate:
- `npm run verify:recorded`
- `node -e "JSON.parse(require('fs').readFileSync('runs/m2-one-shot/metrics/realism_audit.json','utf8')); console.log('realism audit ok')"`

### R2 Real Guideline Candidate IR Path
status: done

Intent: make the existing real-guideline intake do more than display metadata, while keeping it outside locked M1/M2 scoring.

Deliverables:
- Use `corpus/real_guidelines/japanese_guidelines.json` candidate spans and `machine_hint` fields to emit candidate SourceGraph, segment, normalization, and route-rule IR artifacts for real sources.
- Emit explicit residuals for fields that are missing, ambiguous, unsupported by the toy schema, or only author-provided hints.
- Add report coverage tables for real-source candidate spans, admitted candidate rules, rejected residuals, and source/permission hashes.
- Keep real-source outputs labelled `source_intake_candidate_only` or equivalent; do not count them in locked fixture accuracy.

Gate:
- `npm run verify:recorded`
- `node -e "const r=require('./runs/m2-one-shot/report.json'); if (r.real_guideline_intake.scoring_scope !== 'not_in_locked_m1_m2_measurement') process.exit(1); console.log('real-source scope ok')"`

### R3 Less-Leaky Lift Evaluation
status: done

Intent: make the M2 lift comparison less dependent on answer-copying and more informative about weak-model translation behavior.

Deliverables:
- Remove exact target JSON payloads from `route.single_ir` prompts; prompts may provide source spans, allowed schema, and cue definitions, but not the filled answer object.
- Add at least one holdout or mutation fixture group not hardwired into prompt examples.
- Score direct SMT and IR route outputs against the same source-derived evaluator, with diagnostics distinguishing syntax, grounding, unsupported schema, and wrong verdict.
- Update report language to state whether the result is still a scaffolded cue-hop test or a stronger translation test.

Gate:
- `npm run verify`
- `node -e "const p=require('./runs/m2-one-shot/prompts/catalog.json'); if (p.entries.some(e => /Import payload:\\n\\{/.test(e.prompt_text))) process.exit(1); console.log('no exact payload leakage')"`
