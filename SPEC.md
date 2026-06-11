# CKC — Clinical Knowledge Compiler

Design authority for this repository. Sole implementers and readers: Claude (Fable 5 family)
sessions operating under CLAUDE.md, `.claude/commands/session-prompt.md`, and `.agent/`.
The document is optimized for machine reading: stable `§` anchors, tables over prose, one fact in
one place, sections sized for selective loading.

## §0 Mission, thesis, posture

CKC is a headless research harness that maps public Japanese clinical-guideline knowledge into
compact, reusable, source-grounded IR components; compiles them deterministically to formal
targets (SMT-LIB first); and surfaces contradictions and documented null results with end-to-end
machine-checkable evidence.

Thesis under test, as three falsifiable claims, ordered by dependency — each claim builds on
its predecessors' machinery, and test order matches (M2, M3, M5). §2 schedules the experiments,
§7.3 defines the metrics. The layered component IR is the instrument, not a claim: layering is
a route variable inside claim 1, reuse generalization is what claim 2's coverage measures, and
the layered-versus-direct payoff lands as M3's architecture ablation (§10):

1. Short-hop translation (models in the loop): how reliably a weak local model translates
   clinical Japanese into an executable formal target depends on the IR configuration the route
   targets; staged, grammar-constrained, short-hop routes — layered and hop-chain forms
   included — tame model non-determinism and beat direct one-leap emission on the §7.3
   route-quality and conflict-quality families. Tested at M2; widened at M3–M4.
2. Model-free runtime (models at development time only): a compact admitted mapping layer —
   authored and maintained by AI agents, where hand-encoding once made expert systems
   prohibitive — covers fresh documents deterministically with zero runtime model calls; its
   quality is an optimization problem: maximize coverage and reuse, minimize mapping-set size.
   Tested at M3.
3. Autonomous optimization: a bounded autonomous loop over declared surfaces, scored by an
   immutable evaluator, measurably improves the objectives of claims 1–2 — from lexicon repair
   up to search over the IR-combination space — while every attempt stays ledgered and
   replayable. Tested at M5.

Documented null results are first-class outcomes for all three claims.

Stage arc: the plan realizes CKC in three stages, each gated by its predecessor. Stage I —
research instrument (M1–M5): prove claims 1–3 on synthetic corpora; "executable" means compiled
to solver-checked formal targets; locked Stage I measurements anchor a methods manuscript.
Stage II — guideline auditor (M6–M7): the compiler's first application — static analysis of
real public corpora surfacing source-grounded revision candidates for guideline authors,
adjudicated and rendered bilingual; Stage I is the auditor's validity argument (measured
translation reliability, deterministic coverage with zero runtime model calls), and the
auditor's adjudicated findings anchor a second manuscript. Stage III — CDS backend (§13.4,
contract-only): the compiler's runtime target — admitted knowledge evaluated over patient
contexts; "executable" extends to runtime evaluation; every capability sits behind §15 gates.

North-star demonstration (M6 era): cross-source conflict surfacing over real public corpora —
e.g. a guideline recommendation versus a PMDA package-insert contraindication — traced from
Japanese source spans through IR and named SMT assertions to solver cores, replayable from
content hashes alone. Behind it sits an asymptotic ideal: ever more minimal admitted mapping and
axiom sets representing ever more clinical knowledge — a single global axiom in the unreachable
limit — which orients compactness and autonomous optimization (`G-MDL`) while staying outside
every report's claims.

Research posture: every output is research evidence. Accepted
semantics come from admission (schema validity, grounding, canonical bytes, applicable
compiler/verifier checks, trace, replay, applicable gates) — independent of proposer identity.
AI, retrieval, agents, and humans all propose; admission decides. Reports describe results with this
vocabulary: `research harness`, `candidate`, `review candidate`, `formalization-QA`,
`text-quality analysis`, `source-grounded`, `schema-valid`, `verifier-checked`, `replayable`,
`requires human adjudication`, `locked measurement`, `synthetic fixture measurement`,
`raw benchmark output`, `documented null result`. Clinical, patient-care, CDS-runtime, SaMD,
deployment, and regulatory claims sit behind the gates in §15 and enter reports only after their
gates pass.

Claim tiers:

| Tier | Meaning |
| --- | --- |
| `s0_replayable` | Artifact bytes replay; schema/trace checks pass over frozen inputs. |
| `s1_admitted` | s0 plus deterministic validation/admission. |
| `s2_research_evidence` | s1 plus valid benchmark/gate evidence for a stated research claim. |
| `s3_clinical_regulatory` | s2 plus clinical/regulatory/deployment assurance evidence. |

## §1 Operating contract

Intent: every session behaves the same way, learns from prior sessions, and leaves the repository
in a state the next session can trust.

Sources of truth, in order: user instructions > CLAUDE.md > this spec > `.agent/roadmap.md`
(build plan) > `.agent/memory.md` (lessons). Sessions load §1–§2 plus the reading slice their
roadmap unit names; wider loading is reserved for spec-maintenance sessions.

Unit discipline:

- One roadmap unit = one conceptual deliverable + one gate command, finishable and committable in
  a single 200K context window with margin. Calibrate from neighbouring units' `NN%` annotations
  and the sizing lessons in memory; pre-split units that stack a crate foundation, a
  writer-inverse, a recursive type family, or an algorithm plus a second authored artifact.
- Build exactly the unit's deliverable; choose the simplest implementation that passes the gate.
  Record genuine future needs as roadmap candidates for the unit that will consume them.
- Every Rust unit runs `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`, and
  its gate before staging.
- A projected unit overrun is a stop-and-report: recovery (restore to the last commit, re-scope
  the roadmap) is always user-initiated.

Working style (Fable 5):

- When you have enough information to act, act; bring contract-changing decisions, destructive
  actions, and genuine scope changes to the user, and proceed on everything else.
- Audit every progress claim against a tool result from the current session; report failures with
  their output, and state verified results plainly.

Session shapes — context sizing, plan-session workflows, subagent policy — live in the session
command and the `.agent/protocol-*.md` files it routes to; commit, compaction, and memory
discipline live in CLAUDE.md and `.agent/memory.md`.

Spec evolution: the spec grows in place. When a milestone closes (its closing review lands), the
plan session that opens the next milestone is an elaboration session while that milestone's
contract section is still compact: expand it into full normative text (workflow-driven; mine
`docs/` through subagents), present the diff to the user for review, then seed
`.agent/roadmap.md` with the milestone's header and units. Elaboration sessions may also amend
earlier sections when implementation evidence justifies it; contract-affecting amendments reach
the user before any unit consumes them. Acceptance sessions mark the milestone header in the
roadmap with the evidence run id and add the local tag `accept/m<n>`.

Normative language: declarative present tense states binding contract. SHOULD marks a strong
default whose alternative is recorded in a registry, manifest, or gate evidence. MAY marks
options. Versions of packages, solvers, models, and tools live in lockfiles and manifests; prose
names only stable public standards.

## §2 Build plan

Intent: prove the thesis through vertical slices, each ending in a runnable artifact, instead of
assembling the full harness before the first end-to-end result.

| Stage | Deliverable | Proof |
| --- | --- | --- |
| M1 spine | Layered pipeline end-to-end on synthetic Japanese fixtures: extract → segment → normalize → assemble → compile → verify; one deontic contradiction found, one null result documented, full trace, deterministic replay. Pure Rust. | `ckc run --experiment exp.m1_spine` + §8 checklist |
| M2 short-hop PoC | First experiment, claim 1's minimal pair: a weak local model (laptop CPU, grammar-constrained, recorded I/O) translates the M1 fixtures via `route.direct_smt` versus one IR-mediated route; scored on validity/admission/verdict-accuracy/stability raw rows; research report in English and Japanese. | `ckc run --experiment exp.m2_shorthop` + §9 |
| M3 variation + comparison | Route axis widened over existing IR forms (stacked, hop-chain, CKC-layered); direct-formalization ablation pipeline; reuse/compactness/hash-convergence/conflict metrics; metamorphic variant fixtures; ranked comparison report; model-free coverage experiment (claim 1 across the route axis; claim 2 via the coverage experiment and compactness front; layered-versus-direct as architecture ablation). | `ckc run --experiment exp.m3_compare` / `exp.m3_routes` / `exp.m3_coverage` + §10 |
| M4 invented DSLs | Project-born IR/DSL candidates designed for translation reliability: grammar-masked concrete syntax, deterministic parse → IR → compile; singular and layered configurations ranked against the M3 route field on the locked evaluator (claim 1, extended to invented forms). | `ckc run --experiment exp.m4_dsl` + §11 |
| M5 optimization PoC | Bounded autonomous-optimization loop (§12) over declared surfaces against a locked evaluator, optimizing translation reliability, reuse, and coverage; full attempt ledger; driver-portable — local driver for acceptance, Claude-session driver defined (claim 3). | `ckc research loop --experiment exp.m5_loop` + §12 |
| M6 sources + expansion | Public corpus ingestion (fetch/cache, permission records, real Minds/J-STAGE HTML+PDF extraction, tables and DecisionTable IR, MEDIS-anchored terminology, e-PI XML source family, drift checks), then registry-driven growth: retrieval, richer rule semantics, additional solvers/targets, corpus scale, matrix scale-out, the cross-source flagship experiment, deeper DSL capabilities. | §13.1 contract elaborated at M5 acceptance; §13.2 per candidate |
| M7 auditor product | Reviewer-facing audit over M6 corpora: finding triage (severity, bilingual review questions), weighted minimal-correction-set revision localization, cvc5 cross-check on blocking/major findings, Lean per-instance reflection anchor, adjudication records, self-contained bilingual `report.html`, auditor manuscript bundle. | `ckc run --experiment exp.m7_audit` + §13.3 |

Scope note: M1–M5 are the current PoC horizon (Stage I); M6–M7 stay in this file as compact
forward contracts (Stage II) so PoC decisions remain production-compatible; Stage III is
contract-only (§13.4).

Roadmap protocol: `.agent/roadmap.md`, consumed by the session command, carries one milestone at
a time: a header stamped with the commits that open (`plan`) and close (`review`) it, over an
ordered unit checklist whose completed items record context usage and commit hash; closed
milestones persist as bare headers. The plan session that opens a milestone authors its whole
checklist from the milestone's spec section; the milestone is complete when its acceptance item
passes in a dedicated acceptance session and the closing review stamps the header. Lines marked
`user-selected` get scope confirmation from the user before work begins.

Conservation rule: deferred capabilities remain represented — each appears in a
milestone contract (§9–§13), the registry backlog (§14), or a gate (§15). Elaboration sessions
check deferred items against this rule as the sole scope source.

## §3 Architecture and repository

Intent: one toolchain until evidence demands a second; durable semantics in typed Rust; every
stage boundary a validated, content-addressed artifact.

Stack: a Rust workspace (edition 2024) implements everything through M5; external engines (Z3,
the M2 local-model runtime) join as recorded subprocess adapters rather than language bindings.
M6's elaboration decides per extraction/NLP adapter whether to stay Rust or admit a `uv`-managed
Python adapter layer joined only through canonical artifacts and exported JSON Schema; the
decision criteria are determinism, lockability, fixture-tested quality, and maintenance cost,
recorded in the registry. Every milestone runs on a single CPU laptop: small quantized local
models, bounded fixture sets, and per-query solver budgets are the standing sizing assumptions
until the user provides larger hardware.

Crates:

| Crate | Owns |
| --- | --- |
| `ckc-core` | IDs, hashes, rationals, string policies, canonical bytes, envelopes, enums, grounding types, IR, plans/manifests, registry types, validation. |
| `ckc-smt` | FormalIR → SMT-LIB emission, query planning, assertion maps, solver invocation, verdict parsing. |
| `ckc-cli` | `ckc` binary: pipeline stages, runner, trace/report/replay, registry check. |

Pipeline shape (M1–M3; later stages splice in without reshaping):

```text
corpus fixture -> extract -> segment -> normalize -> assemble(IR) -> compile(SMT) -> verify -> trace -> report
```

Boundary invariants:

```text
Rust computes every accepted artifact hash.
All semantic state lives in canonical artifacts on disk; processes hold only caches of them.
Every stage reads declared inputs, validates them by strict canonical read, and writes only under
its run directory.
Runtime metadata stays outside content hashes.
Accepted artifacts carry envelopes (§4.4); streams (events, diagnostics) are runtime evidence.
```

Repository layout (target state; built up by the M1 units):

```text
.
├── SPEC.md  CLAUDE.md  LICENSE  .gitignore
├── Cargo.toml  Cargo.lock
├── crates/{ckc-core,ckc-smt,ckc-cli}/
├── corpus/{fixtures,lexicon,gold}/        # committed, license-clean
├── registry/                              # corpora.yaml candidates.yaml experiments.yaml at M1;
│                                          # grows per milestone (§14)
├── docs/                                  # research compendium (§14), mined via subagents
├── runs/                                  # gitignored run outputs
├── .agent/{memory.md,roadmap.md,compaction.sh}
└── .claude/
```

CLI (M1 surface; later milestones extend):

```text
ckc registry check
ckc run --experiment <experiment-id> --out runs/<run-id>
ckc replay runs/<run-id>
ckc trace --run runs/<run-id> --finding <finding-id>
```

CLI invariants: each command validates inputs, emits JSONL events, writes only under its output
directory, and ends with exactly one total outcome (§4.4). `registry check` verifies every
registry entry referenced by an experiment resolves and is well-formed.

## §4 Kernel contracts

Intent: a small, stable core that every milestone reuses; stability here is what lets artifacts
survive spec evolution.

### §4.1 IDs, hashes, rationals

```text
Id       = lowercase ASCII matching [a-z][a-z0-9_.:-]*
Hash     = "sha256:" + 64 lowercase hex digits
Rational = exact reduced { "num": "<int>", "den": "<positive-int>" }
```

Semantic IDs use lowercase path-like segments; deterministic disambiguation uses source order,
then hash order.

### §4.2 String policies

| Policy | Contract |
| --- | --- |
| `raw_source` | Preserve the extractor-emitted Unicode scalar sequence exactly. |
| `source_nfkc` | Unicode NFKC only. |
| `semantic_ja` | NFKC; fold whitespace to U+0020; collapse runs; trim; fold common Japanese/fullwidth punctuation to deterministic ASCII equivalents. |
| `semantic_en` | NFKC, whitespace/punctuation folding, lowercase ASCII; for controlled-vocabulary identifiers. |
| `identifier_ascii` | Require `[a-z0-9_:./-]+`; store bytes exactly. |
| `diagnostic_text` | NFKC plus semantic whitespace folding. |
| `view_text` | NFKC display text with renderer provenance. |

### §4.3 Canonical payload bytes

```text
Objects: UTF-8 field names sorted by byte order; the strict reader rejects unknown fields.
Optional fields: omitted when absent; the strict reader rejects JSON null.
Arrays: ordered when order is semantic.
Sets: arrays sorted by canonical_sort_key.
Maps: identifier_ascii keys as sorted objects; other keys as sorted key/value arrays.
Strings: UTF-8 under the schema-declared string policy before hashing.
Integers: decimal strings in accepted artifacts.
Rationals: exact reduced objects; the strict reader rejects bare numeric tokens.
Unions: tagged objects with exactly "tag" and "value".
Fieldless enums: identifier_ascii strings.
content_hash = sha256(canonical_payload_bytes(payload)).
```

Each payload type has exactly one byte serialization; the canonical writer and strict reader are
mutual inverses, round-trip tested. Structural hashes of IR components derive from canonical
bytes with locally indexed references, so a component's hash is stable under semantic-id renames.

### §4.4 Envelope, enums, outcomes

Every accepted artifact is one canonical JSON envelope:

| Field | Semantics |
| --- | --- |
| `schema_version` | `"ckc.1"`; bumped on breaking schema change. |
| `schema_id` | Schema identifier, e.g. `schema.ir_bundle`. |
| `artifact_id`, `artifact_kind` | Stable semantic id and kind. |
| `producer` | `{candidate_id, component_id, toolchain_manifest_hash}`. |
| `input_hashes` | Content hashes of consumed accepted artifacts. |
| `content_hash` | Hash of canonical payload bytes. |
| `canonicalization_policy_hash` | Hash of the policy descriptor in force. |
| `origin` | See Origin enum. |
| `authority` | See Authority enum. |
| `accepted_effects` | `[]` for accepted semantic artifacts; evidence-discovery artifacts may record `network`, `clock`, `ai`, `tool`. |
| `trace_refs`, `diagnostics` | Trace links; structured diagnostics (stable codes, §7.4). |
| `runtime_metadata` | Excluded from `content_hash`. |
| `payload` | The typed content. |

Fields ending in `_hash` reference accepted-artifact content hashes unless their schema declares
raw-byte hashing. `compiler_authority` is reserved for compiled artifacts and
`verifier_authority` for verifier results. Accepted semantic authority begins after applicable
schema validation, grounding (§4.5), canonicalization, applicable compiler/verifier checks,
trace/replay recording, and applicable gates.

Enums (stage column = first milestone that uses the value set):

| Enum | Values | Stage |
| --- | --- | --- |
| `Outcome` | `ok residual ambiguity incoherence unsupported invalid`; severity order `invalid > incoherence > unsupported > ambiguity > residual > ok` | M1 |
| `Origin` | `human_authored ai_assisted ai_generated adapter_generated deterministic_compiler` | M1 |
| `Authority` | `source_authority mechanical_authority evidence_discovery_only admitted_authority compiler_authority verifier_authority view_only` | M1 |
| `BindingStatus` | `exact synonym ambiguous unmapped` | M1 |
| `Direction` | `for against contraindicate require permit avoid` | M1 |
| `ClaimTier` | `s0_replayable s1_admitted s2_research_evidence s3_clinical_regulatory` | M1 |
| `ReviewClassification` | `candidate residual ambiguity incoherence replay_failure documented_null_result` | M1 |
| `AttemptClassification` | `improved equivalent dominated regression invalid unsupported timeout crash null_result near_miss unreproducible unauthorized gate_required` | M5 |
| `PromotionDecision` | `promote reject quarantine defer_gate request_replay` | M5 |
| `PromotionScope` | `run_local registry_status` | M5 |
| `Severity` | `blocking major moderate minor info` — finding triage labels | M7 |

Outcome meanings:

| Outcome | Meaning |
| --- | --- |
| `ok` | Output valid for the declared stage. |
| `residual` | Schema-valid but incomplete: permission-limited, missing evidence, missing policy, partial extraction. |
| `ambiguity` | Multiple admissible readings, bindings, spans, or normalizations remain. |
| `incoherence` | Accepted harness inputs collide (e.g. incompatible policy rows); source-level conflicts between guideline rules are findings, delivered as values under `ok`. |
| `unsupported` | Schema-valid construction outside implemented semantics. |
| `invalid` | Schema, hash, canonicalization, registry, or command validation fails. |

Every stage and command returns one total operation result:

```json
{"operation_id":"compile","outcome":"ok","value_hashes":["sha256:..."],"diagnostic_hashes":[],
 "residual_hashes":[],"ambiguity_hashes":[],"incoherence_hashes":[]}
```

Partial success is expressed through typed residual/ambiguity payloads (Hole-style placeholders)
so downstream stages keep operating on the valid remainder and traces stay complete.

### §4.5 Source grounding

| Object | Contract |
| --- | --- |
| `SourceDocument` | Document identity: source family, provenance (`synthetic` or `public`), raw/content hashes, `data_class` (default `none`; populated under §15 gates). |
| `SourceGraph` | Finite node graph (document, section, paragraph, list, table, cell, caption, footnote, CQ, recommendation) plus the spans, anchors, and regions below; one artifact per document, emitted by extract. |
| `SourceSpan` | Stable text span: node, offsets, `raw_text`, `nfkc_text`, `search_text`, reading order, text hash. |
| `SourceAnchor` | Subspan anchor for mentions, quantities, modalities, negation, temporal cues, table values. |
| `SourceRegion` | Closed support set over nodes/spans/anchors/cells; the unit of evidence. |

Grounding invariants:

```text
Every extracted textual unit has a SourceSpan or a typed extraction_uncertain residual.
Every semantic claim carries source_region_ids, or synthetic_fixture_id when injected without a
document form.
Identical source bytes and extraction config produce identical SourceGraph canonical bytes.
Every rule in every report finding exposes its source-grounded rationale (region ids resolve to
quotable spans).
```

### §4.6 Events, replay, provenance

Event fields (JSONL, `events.jsonl`):

```text
event_id run_id candidate_id component_id stage level logical_time started_at ended_at duration_ms
input_hashes output_hashes outcome diagnostics budget_counters
```

Logs are runtime evidence; accepted semantics live only in validated artifacts.
`diagnostics.jsonl` carries §7.4 diagnostic records as JSONL. Run ids are runtime metadata,
excluded from content hashes.

`replay_manifest.json` records command, input hashes, lexicon/corpus hashes, toolchain manifest
hash, environment profile, lockfile hashes, solver identity, and expected output hashes — a
provenance/attestation record over content hashes. `ckc replay` re-executes and compares
canonical content hashes (timestamps and other runtime metadata excluded); mismatches emit
symmetric-difference diagnostics; missing external tools emit `replay_identity_unsupported`.
Repeated deterministic runs over the same inputs produce matching hashes — re-run-equals-prior is
the standing idempotency property check.

## §5 Domain model and IR

Intent: a typed bridge from Japanese prose to formal constraints, with reusable components as the
unit of the thesis.

| Object | Contract (M1 unless tagged) |
| --- | --- |
| `ClinicalSegment` | CQ, recommendation, evidence, exception, definition, table-row, or metadata segment with region refs. |
| `TerminologyBinding` | Mention → concept binding: `system` (M1: `ckc.lex`), code, status (BindingStatus), alternatives, region refs. |
| `ClinicalStatement` | Normalized population, condition, action, modality, strength (`strong\|weak`), certainty (`high\|moderate\|low\|very_low`), exceptions, source refs; comparator/outcome/temporal slots optional at M1. |
| `Action` | Action kind + target concept + discriminating slots (M3) + normalized target key. |
| `ContextExpr` | Finite DNF over atoms: concept predicate, negated concept predicate, quantity interval; M3 adds slot equality and temporal interval (difference-logic) atoms. |
| `NormRule` | `rule_id, context, direction, action, strength, source_region_ids` + optional at M1 `certainty, exception_refs`; exceptions compile to negated context conjuncts, their regions joining `source_region_ids`. |
| `FactualRule` (M3) | Context → factual consequent, strictness. |
| `DecisionTable` (M6) | Input variables, units, rows, guards, outputs, source rows; DMN-style overlap semantics. |
| `IRBundle` | The five layers below + reusable component records + assumptions + diagnostics + per-layer and whole-bundle structural hashes. |
| `CompiledArtifact` | Target id, logic, query plan, query bodies, named-assertion records (assertion id → rule ids → region ids), diagnostics. |
| `VerifierResult` | Per-query status (§6 categories), model or unsat core, solver identity, diagnostics. |
| `TraceBundle` | Derivation DAG + claim-evidence rows; M3 adds reuse/compactness graphs. |
| `LineageIndex` | Query index: artifact/finding ↔ source spans ↔ rules ↔ assertions ↔ verdicts ↔ report. |
| `RunPlan` | Experiment id, fixture groups, pipeline(s), seed, budget; canonical bytes hashed into the manifest. |
| `RunManifest` | Run plan hash, git commit, toolchain/lockfile/corpus/lexicon hashes, environment profile, solver identity, output hashes. |
| `Report` | report.json (canonical) + report.md (derived view): findings, null results, diagnostics, metrics (M2+), wording per §0. |

IR layers in one `IRBundle` per document:

| Layer | Content |
| --- | --- |
| `DocIR` | Layout-preserving text/table view over SourceGraph refs with extraction diagnostics. |
| `SegmentIR` | ClinicalSegments. |
| `ClinicalIR` | ClinicalStatements + TerminologyBindings (+ CQ/PICO/EtD slots, optional M1). |
| `NormIR` | NormRules (+ FactualRules M3, DecisionTables M6). |
| `FormalIR` | Target-independent constraints, normalized actions/contexts, contradiction-query plan. |

IR invariants:

```text
Every reusable action, condition, population, concept, rule, and constraint has a stable Id and a
normalized structural hash; component records list use sites.
IRBundle validates (grounding, references, policy completeness) before compilation.
Assumptions and uncertainty are explicit payload fields.
Layered pipelines expose component reuse metadata; M3 metrics consume it.
```

Lexicon: `corpus/lexicon/ja_core.yaml` is the M1 terminology and modality authority
(system `ckc.lex`): concept entries (id, surface forms, optional interval semantics such as
成人 → `age >= 18`), action verbs, modality phrases mapped to (direction, strength) — e.g.
推奨する → (`for`, strong); 提案する/考慮してもよい → (`for`/`permit`, weak); 禁忌/投与しないこと →
(`contraindicate`, strong); 推奨しない → (`against`, strong); 提案しない → (`against`, weak) —
and certainty phrases (エビデンスの確実性:中 → `moderate`) feeding `certainty` when present.
Versioned by content hash in every manifest. Binding statuses: `exact`/`synonym` satisfy concept
demands (after representative normalization); `ambiguous` emits
`Ambiguity(terminology_ambiguous)` and `unmapped` emits `Residual(terminology_unmapped)` when one
concept is required. External terminologies (MEDIS masters first: license-clean, MHLW-designated)
join at M6 as additional systems behind the same TerminologyBinding contract.

Semantic policy invariants:

```text
Action sameness = same action kind + terminology-representative target + (M3) discriminating
slots, via normalized target keys.
Strength and certainty are proof-visible annotations; conflict logic consumes direction and
normalized action/context.
Missing required policy emits Residual(missing_policy); duplicate policy keys with different
payloads emit Incoherence(incompatible_policy_rows) quarantining only the conflicting rows.
Residual/Ambiguity/Incoherence diagnostics are §7.4 records.
```

## §6 Conflict semantics and formal profile

Intent: small, decidable, witness-producing checks; every verdict names its evidence.

Direction groups:

| Group | Directions |
| --- | --- |
| positive | `for require permit` |
| against | `against avoid` |
| contraindicating | `contraindicate avoid` |

A rule pair is conflict-eligible when normalized actions are the same and one direction is in
`positive` while the other is in `against` or `contraindicating`.

Two-query check per eligible pair (the contradiction-query plan):

```text
Q1 context_overlap: assert both rules' guarded contexts (exceptions as negated conjuncts);
  sat -> overlap witness model recorded; unsat -> pair closed as documented null result
  (no shared context).
Q2 deontic_consistency: for pairs with a sat Q1, assert each rule's direction as a polarity
  literal on the shared action, each as a :named assertion; unsat -> semantic_contradiction with
  unsat core naming the contributing assertions; sat -> documented null result. M3 conflict
  kinds extend Q2 with threshold, slot, and factual constraints.
M3 adds a per-rule Q0 self-check (own guarded context satisfiability; unsat ->
  condition_unsatisfiable) and a raw Q1 view with exception conjuncts stripped: raw sat with
  the guarded view unsat closes the pair as documented null result carrying an
  exception_resolved_conflict finding.
```

Conflict kinds (stage = first milestone that detects them):

| Kind | Stage | Idea |
| --- | --- | --- |
| `context_compatibility` | M1 | Finite context overlap over concept and interval atoms. |
| `normalized_action_sameness` | M1 | Eligibility via normalized action keys. |
| `deontic_direction_conflict` | M1 | Opposed direction groups under satisfiable shared context. |
| `numeric_threshold_empty_intersection` | M3 | Same action+direction, disjoint quantity/temporal intervals. |
| `strict_factual_contradiction` | M3 | Strict factual consequents jointly inconsistent. |
| `terminology_incoherence` | M3 | Functional key collision or mutually exclusive mapping. |
| `condition_unsatisfiable` | M3 | A rule's own context unsatisfiable (Q0): extraction or normalization defect, or genuine source defect. |
| `exception_resolved_conflict` | M3 | Raw overlap sat, guarded overlap unsat: the exception averts a live conflict; informational finding on the closed pair. |
| `table_value_disagreement` | M6 | Overlapping table guards, incompatible outputs. |
| `source_metadata_disagreement` | M6 | Singleton metadata values disagree after normalization. |
| `gloss_drift` | M6 | Rendered view diverges from semantic payload. |
| `replay_or_certificate_failure` | M1 | Replay mismatch or certificate check failure. |
| `package_insert_vs_guideline_conflict` | M6 | Cross-source flagship (e-PI fixtures registered). |
| `priority_ambiguity` | M7 | Conflicting defeasible rules with insufficient superiority metadata (ASP lane, behind the §13.2 richer-rule-semantics trigger). |
| `source_support_mismatch` | M7 | Accepted IR whose cited spans fail adjudicated support review — admission audit over model-assisted authoring. |

SMT profile:

```text
Target: SMT-LIB 2 text artifacts, embedded in CompiledArtifact payloads and materialized
byte-identically under groups/<gid>/smt/ for solver consumption.
Logic: narrowest sufficient logic, recorded per query; M1 default QF_LRA (Bool constants +
linear-real interval atoms). M3 adds difference-logic temporal atoms; declared target profiles
gate anything richer, which otherwise returns unsupported_fragment.
Symbols: SMT symbols are |-quoted canonical Ids, so assertions remain self-identifying.
Every assertion that can influence a query is :named and mapped in the assertion map to IR rule
ids and source region ids; assertion ids form a.<rule_id> (polarity/factual) and ctx.<rule_id>
(context).
Emission is deterministic and byte-pinned (§8.6 listings are exact emitter output): one
s-expression command per line, no comments, the file ending in a newline; command order
set-logic, :print-success false, :produce-models / :produce-unsat-cores as used, declarations
sorted by symbol bytes one per line, named assertions in pair order, check-sat, then the
result command. Guard conjuncts render in stored ContextExpr order, a single-disjunct any
collapses to a bare and, and Rational numerals render as a plain integer when the denominator
is 1, else (/ n d).
Solvers: Z3 required first (binary invocation; identity+version recorded in manifests and
verifier results); cvc5 registered as the second solver (Alethe/LFSC certificate path, §13).
(get-unsat-core) on unsat; witness model on sat where relevant. Verifier adapters parse the
verdict token and result s-expressions, normalize core tokens (strip |…|) to Ids, and record
cores as canonical sets sorted by canonical_sort_key; core comparison is set-based.
```

Verifier result categories: `schema_failure compiler_failure target_syntax_failure
solver_execution_failure semantic_no_conflict semantic_contradiction unknown
unsupported_fragment` — with `sat/unsat/unknown/timeout` and solver diagnostics preserved
distinctly.

## §7 Evidence: traces, reports, metrics, diagnostics

Intent: every claim is a path through artifacts; every miss is a typed datum.

### §7.1 Trace

`trace_bundle.json` holds the derivation DAG (source → extraction → segment → normalization → IR
→ compile → verify → report nodes with operation-labeled edges) and claim-evidence rows (finding
→ region ids → rule ids → assertion ids → verdict → report ref). `lineage_index.json` is its
query index; `ckc trace` resolves a finding to the full chain in both directions. M3 adds
component-reuse and compactness exports plus deterministic path visualizations: `trace_graph.dot`
(sorted nodes/edges) and per-finding Mermaid blocks in `report.md`, rendering the chain from
Japanese source span to solver verdict and the convergence of documents onto shared mapping
components; rendering to images is a view concern with renderer identity recorded. M5 adds
attempt-ledger rows to the trace exports (§12). The lineage index and derivation DAG subsume
dedicated mapping-hypergraph and axiom-dependency exports at fixture scale; those exports
re-stage with M6 corpus scale if measurement demands them.

### §7.2 Reports

`report.json` is canonical; `report.md` is a deterministic rendering; from M2, `report.ja.md`
joins it as a deterministic Japanese rendering of the same canonical content. Contents: corpus and
lexicon hashes, findings (each with conflict kind, rules, regions, quoted spans under permission
rules, assertion names, core), documented null results, a diagnostics summary (code-keyed
failure-taxonomy rollup), solver identity, replay status; from M2, raw metric rows before any
weighted ranking; from M3, ablations; from M5, attempt-ledger summaries; from M6, matrix
coverage.
Finding ids form `finding.<group_id>.<ordinal>` with ordinals in source-then-hash order (§4.1).
From M7, findings carry `severity` (§4.4) and a bilingual suggested review question. From M5,
publication-designated runs export a manuscript bundle — figure-ready CSV/JSON metric tables,
corpus/permission summaries, replay instructions, limitations derived from typed
residual/ambiguity statistics — extended at M7 with finding and adjudication tables (§0 stage
arc: Stage I methods paper, Stage II auditor paper).
Report wording stays within the §0 vocabulary.

### §7.3 Metrics (M2 onward)

Metric values are exact rationals; unavailable values are omitted with a diagnostic; zero
denominators emit `not_applicable` per metric schema. Raw rows always accompany rankings. Core
metric families: reuse (component reuse rate, duplicate rate), compactness (component count,
mapping-set size versus coverage, fan-in/out, MDL proxies), convergence (normalized hash
agreement across variants), compilation (schema/compile/parse/solver pass rates), conflict
quality (precision/recall and conflict-task accuracy over fixture expectations), trace
completeness, determinism (hash stability), baseline delta (per-metric route-versus-baseline deltas over
identical fixtures: model routes from M2, layered-minus-direct from M3), route quality
(schema-valid rate, admission rate, repair count, recorded-call counts, k-sample convergence;
from M2), model-free coverage (share of fresh-document semantics produced deterministically from
admitted mappings, with zero apply-phase model calls; from M3), and loop outcomes (from M5).

### §7.4 Diagnostics

Every diagnostic carries a stable code, a structured payload, region/artifact refs, and maps to
exactly one Outcome. Base code set (some codes first emit with the M3 comparison):

```text
extraction_uncertain table_structure_uncertain span_grounding_missing segmentation_boundary_error
terminology_unmapped terminology_ambiguous terminology_incoherent semantic_slot_missing
missing_policy incompatible_policy_rows unsupported_ir_fragment schema_invalid compiler_error
target_parse_error solver_timeout solver_unknown solver_execution_failure process_crash
trace_incomplete replay_mismatch replay_identity_unsupported deferred_gate_required
false_positive_conflict false_negative_conflict metamorphic_instability
```

M2 adds model-route codes (`ai_schema_violation`, `ai_hallucinated_source`,
`repair_limit_exceeded`); M4 adds invented-DSL route codes; M5 adds loop/budget/surface codes
(`unauthorized_surface_edit`, `budget_exhausted`); M6 adds source/permission/drift codes; each
is defined in its milestone section at elaboration time.

## §8 M1 — Spine (normative)

Intent: the smallest complete instance of the thesis machinery — one layered pipeline, real
Japanese text shapes, a real solver, full trace, deterministic replay. Everything later is
measured against this spine, so its contracts are exact.

### §8.1 Scope

Pipeline `pipe.layered_ckcir_to_smt` over synthetic fixtures; deterministic throughout
(`runtime_ai: false` is the M1 spine condition; recorded model artifacts first appear under §9
contracts at M2). Experiment `exp.m1_spine`.

### §8.2 Fixtures

Committed under `corpus/fixtures/` as minimal well-formed HTML (headings, paragraphs, one list,
one small table) with `registry/corpora.yaml` entries; origin `ai_generated`, authority
`source_authority` on admission, provenance `synthetic` — a working example of
admission-over-proposer authority.

| Fixture | Content | Role |
| --- | --- | --- |
| `fixture.m1_guideline_a` | Minds-style synthetic guideline: CQ + recommendation 「成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する(強い推奨)」 with exception 「ただし、重度腎機能障害のある患者を除く」, plus one definitions table and an evidence list for layout coverage. | Recommendation source. |
| `fixture.m1_guideline_b` | Synthetic companion document: 「成人の敗血症患者のうち、妊娠中の患者には抗菌薬Aを投与しないこと(禁忌)」. | Overlap + contraindication → expected contradiction with A. |
| `fixture.m1_control` | Synthetic document: 「小児(18歳未満)の敗血症患者には抗菌薬Aは禁忌である」. | Age intervals disjoint with A → expected null result. |

Fixture groups in `exp.m1_spine`: `group.m1_conflict = [a, b]` expecting one
`deontic_direction_conflict` finding; `group.m1_null = [a, control]` expecting
`semantic_no_conflict` + `documented_null_result`. Expected outcomes live in
`corpus/gold/m1_expected.yaml`, asserted by the acceptance tests, one entry per fixture group:

```yaml
- group_id: group.m1_conflict
  expected_outcome: semantic_contradiction
  expected_conflict_kind: deontic_direction_conflict
  expected_core: [a.fixture.m1_guideline_a.rule.0, a.fixture.m1_guideline_b.rule.0]   # compared as a set
- group_id: group.m1_null
  expected_outcome: semantic_no_conflict
  expected_null_result: true
```

### §8.3 Stage contracts

| Stage | Contract | Artifact (per document) |
| --- | --- | --- |
| extract | Parse fixture HTML (real HTML parser) → SourceGraph with nodes, spans, anchors, regions; tables preserve row/column/cell/header relations; uncertainty emits typed residuals. | `source_graph.json` |
| segment | Rule-based segmentation keyed on fixture structure (CQ headings, recommendation/exception sentence markers) → ClinicalSegments with region refs. | `segments.json` |
| normalize | Lexicon-driven: bind mentions (TerminologyBindings), normalize statements (ClinicalStatements), derive NormRules with guarded contexts; interval semantics from lexicon (成人/小児 → age bounds). | `normalization.json` |
| assemble | Validate and assemble the five-layer IRBundle; per-layer and bundle structural hashes; component records. | `ir_bundle.json` |
| compile | Across each fixture group: eligibility scan, contradiction-query plan, deterministic SMT emission, assertion map. | `groups/<gid>/compiled.json` + `groups/<gid>/smt/<query>.smt2` |
| verify | Invoke Z3 per query; parse verdicts, cores, models into VerifierResults. | `groups/<gid>/verifier_results.json` |
| trace | Assemble TraceBundle + LineageIndex across the run. | `trace_bundle.json`, `lineage_index.json` |
| report | Render report.json/report.md; write run + replay manifests. | `report.json`, `report.md`, `manifest.json`, `replay_manifest.json` |

Run layout:

```text
runs/<run-id>/
├── manifest.json  replay_manifest.json  report.json  report.md
├── trace_bundle.json  lineage_index.json
├── artifacts/<doc-id>/{source_graph,segments,normalization,ir_bundle}.json
├── groups/<group-id>/{compiled.json,verifier_results.json,smt/<query>.smt2}
└── logs/{events.jsonl,diagnostics.jsonl}
```

### §8.4 Registries at M1

`registry/corpora.yaml` (fixtures above), `registry/candidates.yaml` (the pipeline and its stage
components with ids, kinds, determinism, input/output artifact kinds), `registry/experiments.yaml`
(`exp.m1_spine`: fixture groups, pipeline, seed, budget, expected-outcome ref). `ckc registry
check` validates all three and verifies each pipeline's stage components chain: every stage's
declared input artifact kinds are produced by its predecessors.

### §8.5 Acceptance checklist

1. `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and
   `cargo test --workspace` pass.
2. `ckc registry check` passes.
3. `ckc run --experiment exp.m1_spine --out runs/m1` completes with outcome `ok`, emitting the
   §8.3 artifact set with every accepted artifact passing strict canonical read (enforced by a
   workspace test over the run directory).
4. Every named assertion in each `compiled.json` maps to IR rule ids and source region ids.
5. `group.m1_conflict` yields `semantic_contradiction` with an unsat core naming assertions
   derived from both documents.
6. `group.m1_null` yields `semantic_no_conflict` and a `documented_null_result` entry in the
   report, evidenced by the Q1 unsat (disjoint age intervals).
7. `ckc trace --run runs/m1 --finding <finding-id>` prints the complete chain: source spans →
   segments → statements → rules → named assertions → solver verdict → report finding.
8. `ckc replay runs/m1` reports matching canonical content hashes for all accepted artifacts.
9. `report.md`/`report.json` carry findings, the null result, diagnostics, solver identity, and
   §0-vocabulary wording, with quoted Japanese spans resolving to fixture bytes.

### §8.6 Worked thread (docA × docB)

Source span (docA): 「成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する」 + exception
span 「ただし、重度腎機能障害のある患者を除く」.

Ids: `rule_id = <document_id>.rule.<k>` in derivation order (`rules[k]` derives from
`statements[k]`; document ids are the corpora fixture ids), so rule ids — and the assertion
names built from them — stay unique when one SMT file cores several documents; every other id
is a document-local counter (regions `r.<k>`, exception clauses `exc.<k>`).

NormRule (canonical payload: fields byte-sorted, atoms as §4.3 tagged unions, conjunct sets
sorted by canonical_sort_key):

```json
{"action":{"key":"act.administer:drug.abx_a","kind":"act.administer","target":"drug.abx_a"},
 "context":{"any":[{"all":[
   {"tag":"concept","value":"cond.sepsis"},
   {"tag":"concept_negated","value":"cond.renal_severe"},
   {"tag":"interval","value":{"ge":"18","var":"q.age_years"}}]}]},
 "direction":"for","exception_refs":["exc.0"],
 "rule_id":"fixture.m1_guideline_a.rule.0",
 "source_region_ids":["r.2","r.3"],
 "strength":"strong"}
```

docB yields `fixture.m1_guideline_b.rule.0`: context `cond.sepsis ∧ age ≥ 18 ∧ cond.pregnancy`,
direction `contraindicate`, same action key → pair eligible.

Q1 `q.m1_conflict.pair1.overlap` (QF_LRA; expected sat, witness model recorded):

```smt2
(set-logic QF_LRA)
(set-option :print-success false)
(set-option :produce-models true)
(declare-const |cond.pregnancy| Bool)
(declare-const |cond.renal_severe| Bool)
(declare-const |cond.sepsis| Bool)
(declare-const |q.age_years| Real)
(assert (! (and |cond.sepsis| (not |cond.renal_severe|) (>= |q.age_years| 18)) :named |ctx.fixture.m1_guideline_a.rule.0|))
(assert (! (and |cond.pregnancy| |cond.sepsis| (>= |q.age_years| 18)) :named |ctx.fixture.m1_guideline_b.rule.0|))
(check-sat)
(get-model)
```

Q2 `q.m1_conflict.pair1.deontic` — polarity literals on the shared action (overlap witnessed
by Q1); expected unsat, the core recorded as the canonical set:

```smt2
(set-logic QF_UF)
(set-option :print-success false)
(set-option :produce-unsat-cores true)
(declare-const |pos:act.administer:drug.abx_a| Bool)
(assert (! |pos:act.administer:drug.abx_a| :named |a.fixture.m1_guideline_a.rule.0|))
(assert (! (not |pos:act.administer:drug.abx_a|) :named |a.fixture.m1_guideline_b.rule.0|))
(check-sat)
(get-unsat-core)
```

VerifierResult: `semantic_contradiction`, core
`[a.fixture.m1_guideline_a.rule.0, a.fixture.m1_guideline_b.rule.0]`. Report finding
`finding.group.m1_conflict.1` cites both rules, their regions, the quoted spans, the core, and
classifies as `deontic_direction_conflict`, claim tier `s1_admitted`, wording `synthetic fixture
measurement`. The control group's Q1 is unsat (`age >= 18` vs `age < 18`), closing as
`documented_null_result`. `ckc trace` walks the chain from 「妊娠中の患者には…投与しないこと」 to
the core and back.

## §9 M2 — Short-hop translation PoC (contract; elaborate at M1 acceptance)

Intent: the first experiment — claim 1's minimal pair on this laptop. Establish as a locked
measurement that a weak local model translating clinical Japanese directly into an executable
formal target is unreliable, and that one IR-mediated route measurably improves reliability on the
same inputs; publish the result as a bilingual research report. The M1 spine is the instrument:
its deterministic pipeline supplies the gold verdicts and the calibrated compile → verify back
end that scores both routes, so route failures attribute to translation, not to the instrument.

Committed direction:

- Model harness: a llama.cpp-family local runtime invoked as a recorded subprocess (the Z3
  pattern): greedy decoding with a fixed seed (k-sample convergence draws k recorded samples via
  per-sample seeds), grammar-constrained output via GBNF/JSON-Schema compiled from the §4/§5
  type schemas — the committed `schemas/` export and `registry/{schemas,prompts}.yaml` land here
  (§14) to feed grammars and prompt templates. Model identity, quantization, and runtime version
  live in manifests; the baseline SHOULD be a small Japanese-capable instruct model (sub-4B, CPU
  quantized) weak enough that direct-route failures are common — that headroom is the
  experiment. Model I/O records as fixture artifacts (origin `ai_generated`, authority
  `evidence_discovery_only`, prompt-template hashes in manifests); recorded bytes replay
  deterministically; live calls run only under an explicit experiment flag with full recording.
- Exactly two routes — the minimal pair (further routes are §10 scope):

| Route | Shape |
| --- | --- |
| `route.direct_smt` | Model emits SMT-LIB text directly — the weak baseline. |
| `route.single_ir` | Model fills one grammar-constrained IR schema; deterministic compile from there. Elaboration picks the layer: a CKC IR layer (the §6 compiler takes over) is the default; an existing-IR shape (e.g. DMN-style condition/action rows) is the registered alternative. |

- Inputs: the M1 fixtures, lexicon, and gold, frozen under a minimal measurement record —
  fixture/gold/schema/prompt/model/runtime hashes in the run manifest (the evaluator identity
  that §10 formalizes and §12 locks).
- Scoring (§7.3 route-quality and baseline-delta metrics, raw rows before any ranking): target syntactic
  validity (solver parse), admission rate — model output passes the same §4 admission checks as
  any artifact — conflict-verdict accuracy against gold over the §8 conflict and null groups,
  and k-sample verdict stability; §6 categories and the §7.4 M2 model-route codes carry the
  failure taxonomy; documented null results are first-class.
- Report: `report.md` (English) and `report.ja.md` (Japanese) render deterministically from one
  canonical `report.json` (§7.2): per-route raw rows, the baseline-delta table, findings with quoted
  Japanese spans and named assertions, failure-taxonomy summary, model and solver identities,
  replay status; wording per §0 (locked measurement, synthetic fixture measurement; no clinical
  claims).
- Deliberately out of scope, landing in §10: additional routes, metamorphic fixtures, the
  component store, the deterministic direct pipeline, model-free coverage, ablations.

Acceptance themes (finalized at elaboration): both routes execute over identical locked inputs
(`exp.m2_shorthop`); recorded model I/O replays byte-stably; raw rows emit before the
baseline-delta table; expected conflict/null outcomes hold per gold for admitted translations;
the bilingual report renders deterministically from `report.json`; §0 vocabulary holds.

## §10 M3 — IR variation and comparison (contract; elaborate at M2 acceptance)

Intent: widen claim 1 across the route axis — vary and layer existing IR forms — and take the
claim-2 measurements with the full evaluator; the layered-versus-direct architecture ablation
quantifies reuse and convergence on a corpus designed to exercise them.

Committed direction:

- Routes extending the §9 pair (concrete existing-IR schemas picked at elaboration from
  `docs/`, registered as §8.4 candidate entries):

| Route | Shape |
| --- | --- |
| `route.stacked_ir` | Model fills a stack of existing IR forms (e.g. PICO frame → rule rows); deterministic compile. |
| `route.ir_hop_chain` | Model translates across a chain of adjacent, deliberately similar IR dialects — several small constrained hops, each a minimal semantic delta — testing whether short hops tame model non-determinism better than one long jump. |
| `route.ckc_layered` | Model fills CKC layers stage by stage (segment → statement → rule), each grammar-constrained; the §6 compiler takes over. |

- Every route registers its schemas/grammars and a deterministic bridge into the §6 profile,
  keeping conflict-task scoring identical across routes; all §9 and §10 routes run
  `exp.m3_routes` under one frozen-measurement identity, and §7.3 route-quality, baseline-delta,
  conflict-task accuracy, and k-sample convergence metrics emit as raw rows before ranking.
- `pipe.direct_rule_to_smt` (`exp.m3_compare`, the deterministic architecture-ablation
  baseline): extract → segment → direct phrase-normalization → FormalIR → SMT, bypassing shared
  ClinicalIR/NormIR component reuse; unused stages emit pass-through artifacts (outcome `ok`,
  payload marker `not_applicable`) under the same envelope rules.
- Fixture growth: 4–6 additional synthetic documents sharing populations/actions/conditions
  across documents (reuse pressure), plus deterministic metamorphic variants of M1 documents
  (punctuation, kana/kanji, section order) committed as mutation fixtures with declared
  provenance, plus threshold-conflict and factual-conflict cases for the M3 conflict kinds.
- Component store: run-scoped index of reusable components keyed by normalized structural hash;
  layered pipeline records hits/misses; `component_reuse_graph.json` and
  `compactness_front.json` join the trace exports — the front doubles as the
  mapping-minimization view (claim 2's optimization objective, measured deterministically here).
- Path visualizations per §7.1 (per-finding chain; cross-document component convergence).
- Metrics per §7.3 over both pipelines and every route; the per-metric layered-minus-direct
  deltas are the staged pipeline's §7.3 baseline-delta measurement; `candidate_diff.json` compares segment,
  binding, rule, assertion, verdict, and metric levels; `ranking.csv` + `score_breakdown.json`
  with raw rows.
- Frozen-measurement record: the run manifest freezes the M3 evaluator identity — fixture,
  gold, lexicon, and metric-code hashes (`evaluator_lock.json` extends this identity with full
  semantics in M5).
- M3 conflict kinds (§6 table) implemented: `numeric_threshold_empty_intersection`,
  `strict_factual_contradiction`, `terminology_incoherence`, `condition_unsatisfiable`,
  `exception_resolved_conflict`; ambiguous/unmapped binding paths exercised by fixtures.
- Deterministic ablations reported alongside metrics: `exceptions_off`,
  `terminology_grounding_off`.
- Model-free coverage experiment (`exp.m3_coverage`, claim 2): fixture set A builds mappings and
  admitted entries join the lexicon/component store; fixture set B (fresh documents sharing
  components) then runs `runtime_ai: false` (§8.1). Metrics: model-free coverage of B,
  accuracy versus gold, mapping-set size versus coverage on the compactness front, and
  apply-phase model-call count (zero) against a model-per-document baseline. Apply-phase path
  graphs (§7.1) contain zero model nodes — the runtime removal made visible.
- `registry/methods.yaml` seeded from the `docs/` compendium (§14).
- Wording: route results are locked measurements (s0/s1 raw rows); runtime-oracle fidelity
  claims sit behind `G-RUNTIME-ORACLE`.

Acceptance sketch (finalized when M3's roadmap units are authored): all registered routes and
both deterministic pipelines run over all fixture groups; metrics emit exact-rational raw rows;
hash-convergence asserts identical component hashes across metamorphic variants for the layered
pipeline; the comparison report ranks pipelines and routes with raw rows visible; recorded model
I/O replays byte-stably; path and reuse visualizations emit with deterministic bytes; expected
conflict/null outcomes hold per gold; replay holds for both pipelines; `candidate_diff.json` is
complete; the coverage report emits with raw rows first.

## §11 M4 — Invented IR/DSLs (contract; elaborate at M3 acceptance)

Intent: claim 1 extended to invented forms — project-born IR/DSLs designed for weak-model translation
reliability and deterministic compilation, evaluated with the same instrument as every existing
IR form, in singular and layered configurations. A documented null result — no invented form
beats the §10 field — is a first-class outcome.

Committed direction:

- DSL program: candidate DSLs authored at development time (§0 posture — anything proposes,
  admission decides): compact concrete syntax under a grammar mask, deterministic
  parse → IR bridge → §6 compile; schemas, grammars, parsers, and prompt templates registered
  per candidate (§14). `route.ckc_dsl` — model emits a compact project-born DSL under a grammar
  mask; deterministic parse → IR → compile — is the first entry.
- Configurations: each candidate runs singular and layered — stacked and hop-chain compositions
  over invented and existing dialects — extending the §10 route axis under the same
  frozen-measurement identity (`exp.m4_dsl`).
- Design dimensions recorded per candidate: token compactness, grammar constraint strength,
  semantic distance per hop, layer composability — the seed coordinates of the §12 search
  space.
- Scoring and reporting identical to §10; baseline deltas measured against both `route.direct_smt` and the
  best §10 route; §7.4 M4 invented-DSL route codes land at elaboration.
- Deeper DSL capabilities (typed-hole authoring, proof export, full kernel — the CKC-GEN
  direction) stay §13 candidates behind evidence from this milestone.
- Elaboration MAY add an informalization round-trip metamorphic — accepted IR rendered to a
  deterministic informal summary, re-formalized through a route, compared by normalized hash —
  as a route-stability check.

Acceptance themes (finalized at elaboration): at least two invented candidates execute singular
and layered over identical locked inputs; ranked against the §10 field with raw rows first;
recorded model I/O replays byte-stably; §0 vocabulary holds.

## §12 M5 — Autonomous optimization PoC (contract; elaborate at M4 acceptance)

Intent: claim 3 — `ckc research loop --experiment exp.m5_loop` runs a bounded
propose → patch → run → score → classify → promote/reject → replay → ledger cycle that improves
claims 1–2's objectives under an immutable evaluator. The PoC runs on laptop budgets; the loop
contract is built to outgrow them.

Committed direction:

- `EvaluatorLock` (`evaluator_lock.json`, extending the §10 M3 identity) materialized before
  attempts: fixture/gold/schema/metric/evaluator-code/toolchain/seed/budget hashes, immutable
  per experiment; per-attempt `attempt_run_lock` records evaluator-lock, candidate-graph (the
  resolved §8.4 pipeline+config identity hash), and patch/workspace hashes.
- Declared editable surfaces for the PoC: lexicon entries, prompt templates, route/DSL
  configuration (grammar included). The evaluator stays outside every candidate's editable
  surfaces; an attempt editing locked surfaces classifies as `unauthorized` (diagnostic
  `unauthorized_surface_edit`) and stays unscored.
- Objectives: §7.3 baseline delta, route quality, model-free coverage, and reuse — promotion requires
  (improvement on at least one objective, or front membership), every objective within
  regression thresholds, schema validity, trace completeness, and replay success.
- Ledger: every attempt, whatever its AttemptClassification (§4.4), lands in append-only
  `experiment_ledger.jsonl` (+ derived CSV/MD) with a run-local PromotionDecision (§4.4);
  locally promoted attempts replay deterministically.
- Budgets: max attempts/promotions/failures, wall-clock, and token counters per attempt and per
  loop; exhaustion stops the loop with `Residual(budget_exhausted)`, preserving completed and
  partial evidence.
- Authority: run-local promotion changes ledgers/reports only. Registry/status promotion carries
  from/to status, evidence and replay hashes, rollback, and applicable gates (`G-AUTO-PROMOTE`);
  evaluator-identity changes (fixtures, gold, schemas, metrics, evaluator code, thresholds)
  score only in a separate `G-EVALUATOR-MIGRATION` experiment.
- Mapping-gap repair (council pattern): unmapped/ambiguous residuals from new documents seed
  proposals; several independent proposer agents draft mapping deltas, and a convergence
  criterion — agreement over normalized proposal hashes — gates patch admission; dissenting
  proposals stay in the ledger.
- Loop drivers: the loop contract (lock, surfaces, budgets, ledger, admission) is
  driver-independent, with the driver an ExperimentPlan field recorded in manifests.
  `driver.local` — this PoC's acceptance driver — runs recorded local models on the laptop.
  `driver.claude_session`, a §8.4 candidate entry, runs proposer/council/patch steps as Claude
  agent sessions (a slash command under `.claude/commands/` plus headless invocation, authored
  at this milestone's elaboration), with API cost in the budget fields; it ships authored and
  registered, exercised on user request. Long-horizon loops run on the agent driver when scale
  demands; evaluator locks, admission, and ledgers stay identical across drivers.
- Standing long-run objectives: route/IR-combination search over the `registry/methods.yaml`
  universe (§14) — existing formalisms and the §11 invented-DSL program; the claim-1
  configuration space is combinatorial — and mapping-set minimization toward the §0 asymptotic
  ideal, under `G-MDL` for any calibrated minimality claim.
- Scale-out — `ExperimentPlan` matrices with compatibility filters, pairwise/fractional designs,
  Pareto/beam narrowing, and coverage classification (untested, skipped-incompatible,
  unsupported, failed, dominated, equivalent, Pareto-front, promising) — extends this contract
  when candidate spaces outgrow the PoC (M6).

Acceptance themes: the loop executes on `driver.local` within budgets over at least two
surfaces, with the driver named in the manifest; the ledger holds at least one valid scored
attempt and one rejected or dominated attempt; an unauthorized-surface patch is classified and
stays unscored; at least one locally promoted attempt replays; ledger summaries emit as CSV/MD.

## §13 Stage II and beyond — sources (M6), auditor product (M7), CDS-backend contract

Intent: the spine, comparison, and admitted translation routes run end-to-end on real public
Japanese guideline material with permission-aware caching and richer extraction, followed by
registry-driven growth where every candidate enters behind benchmark evidence and applicable
gates. M7 turns the audited corpus into the reviewer-facing auditor product; §13.4 keeps the
Stage III CDS-backend target visible behind gates.

### §13.1 Public sources (contract; elaborate at M5 acceptance)

- Fetch/cache: content-addressed store under `corpus/raw/` (gitignored), resumable, with
  `PermissionRecord` per source (rights holder, access ref, license label,
  `redistribution_status ∈ redistributable|reconstructable|restricted_internal_only`, allowed
  artifact classes) and deterministic redaction policy; blocked exports emit
  `Residual(permission_limited)` and continue. New source families/export classes trigger
  `G-SOURCE-PERMISSION`.
- Source families: Minds-style guideline HTML/PDF (full text treated internal-only with
  offsets/hashes/derived labels exportable; spans quoted in reports only where permitted),
  J-STAGE/JATS XML, and PMDA e-PI XML (license-clean structured sections — 禁忌/効能/用法 — and
  the future cross-source counterpart). Licensed textbook EPUB/PDF joins as a
  `restricted_internal_only` family when rights evidence exists — corpus expansion, not M6
  acceptance; textbooks need the permission machinery, not new schema.
  `registry/source_processors.yaml` declares per-family adapters, stages, permission behavior,
  drift policy, diagnostics.
- Extraction: real HTML/XML parsing extended to PDF text/layout and table structure with
  uncertainty diagnostics; DecisionTable IR + `table_value_disagreement`; scanned-page OCR as a
  separate low-trust lane (engine identity and confidence recorded; OCR text feeds review
  surfaces and mapping authoring, with accepted formalization requiring validated spans);
  quantity/unit normalization (exact rationals plus canonical unit codes with committed
  UCUM-compatible conversion tables; raw Japanese unit strings preserved; threshold conflicts
  compare unit-normalized values only); gold segment/statement labels for at least one real
  fixture; extractor promotion claims trigger `G-EXTRACTOR-ADAPTER`.
- Terminology: MEDIS standard masters (病名/HOT) as the first external systems behind the
  TerminologyBinding contract; version-pinned snapshots; JLAC10/11 laboratory codes registered
  next; license-encumbered vocabularies (SNOMED CT, MedDRA/J, LOINC) stay registry-listed until
  licensing evidence exists.
- Drift: source hash changes emit `source_drift.json` and mark dependent scores stale.
- Boundary: the committed schemas exported since M2 govern any cross-language boundary; the
  Rust-vs-Python adapter decision per §3 is made and recorded here.

M6 acceptance themes (finalized at elaboration): the M1–M5 experiment set re-runs end-to-end
over at least one real Minds-family corpus slice plus its e-PI counterpart with live permission
records, redaction, and drift checks; the cross-source flagship experiment registers.

### §13.2 Expansion principles (elaborate per candidate)

| Candidate | Adoption trigger |
| --- | --- |
| Sparse retrieval (BM25); license-clean dense/rerank models | Corpus scale demands navigation. |
| Richer rule semantics: defeasible priorities/superiority, ASP/Clingo, argumentation | Exception-as-context-conjunct measurably under-fits real guidelines. |
| Additional targets: cvc5 certificates → Lean/Isabelle replay; DMN table semantics; Alloy/TLA+ pipeline properties; e-graph canonicalization | Verifier-portfolio, table-semantics, or convergence evidence demands them. |
| Corpus-scale sweeps; matrix scale-out, long-horizon agent-driver loops, IR-combination search (§12) | Candidate spaces outgrow the PoC. |
| `package_insert_vs_guideline_conflict` flagship | §13.1 e-PI fixtures registered. |
| DSL/CKC-GEN beyond the M4 program: typed-hole authoring, proof export, full kernel | §11/§12 evidence favors deeper invented-IR investment. |

The §2 conservation rule keeps this table in sync with `registry/methods.yaml`.

### §13.3 M7 — Auditor product (contract; elaborate at M6 acceptance)

Intent: Stage II's reviewer-facing deliverable — the compiler as guideline auditor. Real-corpus
findings become adjudicable revision candidates with formal evidence, rendered bilingual and
exported as a manuscript bundle; a documented absence of defects in an audited corpus is itself
a publishable null result. Container probes for every committed backend ran 2026-06-12 (r3
revision commit).

Committed direction:

- Revision localization: per finding cluster, weighted minimal correction sets via solver
  soft-assertions (Z3 `assert-soft`; weights from strength, certainty, and source authority
  class, declared in the experiment registry); MARCO-style MUS/MCS enumeration in the Rust
  adapter when clusters outgrow single calls. Findings render "these k passages jointly imply
  an impossibility" with member spans.
- Verifier cross-check: cvc5 replays every blocking/major finding's queries; agreement,
  divergence, or unknown recorded per query; divergence emits a review item; evidence feeds
  `G-PORTFOLIO`. The cvc5 adapter parses verdict tokens and tolerates result-command errors
  after non-matching verdicts (the Z3-adapter pattern); §6 emission stays byte-pinned.
- Mechanized anchor: a Lean 4 package defines the NormIR/FormalIR fragment, the §6 conflict
  predicates, and normalizer properties; per-run generated data files; per-instance checks by
  `decide`/`native_decide` recorded in the trace with replay commands (kernel reduction stalls
  on String-order-heavy computation — `native_decide` or Nat-keyed encodings); generic
  theorems land as explicit proof-debt records, never silent assumptions.
- Finding triage: severity (§4.4) plus bilingual suggested review questions; wording stays
  §0-calibrated — `warrants review` by default, contradiction vocabulary only for proven
  inconsistency within supported semantics.
- `AdjudicationRecord`: append-only reviewer-role-typed records (clinician, formalist,
  terminology, adjudicator) attached to findings by hash, never mutating them; agreement
  statistics in reports; adjudicated-corpus claims trigger `G-GOLD-CORPUS`.
- `report.html`: one self-contained deterministic bilingual review artifact per run — embedded
  canonical report/trace data plus committed content-hashed viewer assets; Japanese spans
  primary, English glosses linked per span; corpus overview, rule browser, finding list with
  filters, finding detail with formal evidence and revision candidates, metrics; renderer
  identity recorded; zero servers, zero network, zero external toolchain in the build path.
- Auditor manuscript bundle: extends the §7.2 bundle with finding/adjudication tables and
  per-kind defect statistics for the Stage II paper.

Acceptance themes (finalized at elaboration): an auditor run over the M6 corpus emits triaged,
localized, cross-checked, anchor-checked findings; a reviewer walks source span → rule →
assertion → verdict → review question entirely offline in `report.html`; adjudication records
round-trip without mutating findings; the bundle exports; replay holds.

### §13.4 Stage III — CDS-backend contract (gated; no build commitment)

The compiler's runtime target, kept visible so Stage I/II decisions stay compatible.
Capabilities enter only behind their gates, each as a registered candidate citing its
compendium row: a three-valued rule evaluator over typed patient contexts (`applicable |
not_applicable | unknown` plus conflict statuses; open-world missing-data semantics;
`G-EXEC-EVAL` adoption defines the semantics before any build), FHIR-family interop exports
(JP Core patient substrate, Clinical Reasoning packaging, CQL/ELM where expressible, lossiness
recorded per export), EHR ingestion (SS-MIX2, CDS Hooks/SMART), live-patient data
(`G-LIVE-PATIENT`), probabilistic and world-model semantics (`G-PROB`, `G-WORLD-MODEL`),
clinical deployment authority (`G-S3`).

## §14 Registries and research compendium

Registry files are data, validated by `ckc registry check`, growing per milestone: M1
`corpora|candidates|experiments`; M2 adds `prompts|schemas` (the schema export feeds M2's
grammar constraints); M3 adds `methods`, the method-universe catalogue seeded from the
compendium (families, aliases, candidate roles, adapter status
`v_required|v_optional|registered_backlog|gate_only`, benchmark tags, compatibility metadata);
M4 extends `schemas|prompts` with invented-DSL entries; M5 adds `evaluators|gates` (gate
evidence objects); M6 adds `source_processors|policies` and `indexes` with retrieval; M7 adds
`adjudication` and `views` (content-hashed `report.html` viewer assets).

`docs/` is the committed research compendium — method-category deep-research
reports plus the agent-language catalogue, scope-pruned to the build plan (pruned surveys live
in git history). Registry-seeding and elaboration units mine it through read-only subagents and
cite `file §section` in registry notes; main sessions keep their own context lean.

## §15 Gates

Gates carry every stronger-than-research claim; each is a one-line trigger plus an evidence
object, defined fully when first triggered. `GateEvidenceRef` names gate, subject hash, evidence
hash, replay identity, enabled claims, limitations, rollback/sunset. A missing gate emits
`Residual(deferred_gate_required)` for the stronger claim only — locked lower-tier measurements
stand on their own.

| Gate | Trigger | Evidence object |
| --- | --- | --- |
| `G-SOURCE-PERMISSION` | New source family, redistribution mode, or export class. | `SourcePermissionProfile` |
| `G-GOLD-CORPUS` | Adjudicated/released corpus-quality claims. | `GoldCorpusEvidence` |
| `G-EXTRACTOR-ADAPTER` | Extractor promotion or generalized extraction-quality claims. | `ExtractorAdapterRecord` |
| `G-RET-PARITY` | Retrieval-quality claims. | `RetrievalParityReport` |
| `G-PORTFOLIO` | Multi-verifier agreement/robustness claims. | `VerifierPortfolioReport` |
| `G-AIR-FULL` | Richer abstract-domain logic affecting accepted outputs. | `AIRDomainRecord` |
| `G-REBIND` | Proof/trace transport across source or terminology editions. | `RebindingEvidence` |
| `G-EMIN` | Released benchmarks, corpus-scale or calibrated performance claims. | `BenchmarkRelease`, `EMinReport` |
| `G-EVALUATOR-MIGRATION` | Changes to fixtures/gold/schemas/metrics/evaluator code for future scoring. | `EvaluatorMigrationEvidence` |
| `G-MDL` | Calibrated compression/Pareto/model-selection claims. | `MDLEvidence` |
| `G-RUNTIME-ORACLE` | Runtime-model-call or IR-stage oracle fidelity claims. | `RuntimeOracleReport` |
| `G-AUTO-PROMOTE` | Automated registry/status promotion of accepted generators, prompts, policies, compilers, verifier adapters, metric/report code. | `AutoPromotionEvidence` |
| `G-PROB` | Probabilistic semantics affecting accepted outputs. | `ProbabilisticProfileRecord` |
| `G-WORLD-MODEL` | Latent-state/multimodal observations affecting outputs. | `WorldModelProfileRecord` |
| `G-EXEC-EVAL` | Patient-context rule-evaluation semantics in any shipped output. | `ExecEvalProfileRecord` |
| `G-LIVE-PATIENT` | Any patient-derived data entering CKC. | `GovernedPatientDataProfile` |
| `G-S3` | Clinical/regulatory/deployment authority claims. | `S3AssuranceEvidence` |

Gate invariants: gate evidence is replayable or explicitly marked non-authoritative; candidate
loops run inside locked experiments, with evaluator changes governed separately before any
ranking that depends on them; regulatory-framework vocabulary (assurance cases, SaMD classes,
APPI categories, SBOM fields) enters the spec only through these evidence objects when their
gates first trigger.
