# CKC — Clinical Knowledge Compiler — spec04

Design authority for this repository. Sole implementers and readers: AI-agent sessions operating
under AGENTS.md and `.agent/`.
The document is optimized for machine reading: stable `§` anchors, tables over prose, one fact in
one place, sections sized for selective loading.

Lineage: spec04 supersedes spec03 (archived as `archive/spec03`); earlier work lives in
`archive/spec02` (completed M0 of a proof-carrying-compiler spec) and `archive/spec01` (Phase-0
kernel). Milestone numbering restarts at V1; archive milestone names (M0/M1) belong to their own
specs. This main is a clean slate: histories share no commits and code rebuilds fresh; §4 kernel
contracts match `archive/spec03`'s ckc-core byte-for-byte, making it designated prior art (§8.7).

## §0 Mission, thesis, posture

CKC is a headless research harness that maps public Japanese clinical-guideline knowledge into
compact, reusable, source-grounded IR components; compiles them deterministically to formal
targets (SMT-LIB first); and surfaces contradictions and documented null results with end-to-end
machine-checkable evidence.

Thesis under test, as four falsifiable claims:

1. Reuse: a layered IR of reusable components — verified once, reused by normalized hash,
   compiled deterministically — outperforms direct per-document formalization on reuse,
   compactness, hash convergence, compilability, conflict precision/recall, and trace quality.
2. Lift (models in the loop, role minimized): IR configuration changes how reliably a weak
   local model translates clinical Japanese into symbolic executable form; staged,
   grammar-constrained, short-hop routes tame model non-determinism, lifting schema validity,
   admission rate, and conflict-task accuracy over direct emission.
3. Amortization (models out of the runtime): a compact admitted mapping layer — authored and
   maintained by AI agents at development time, where hand-encoding once made expert systems
   prohibitive — covers fresh documents deterministically with zero runtime model calls; its
   quality is an optimization problem: maximize coverage and reuse, minimize mapping-set size.
4. Autoresearch: a bounded autonomous loop over declared surfaces, scored by an immutable
   evaluator, measurably improves the objectives of claims 1–3 — from lexicon repair up to
   search over the IR-combination space — while every attempt stays ledgered and replayable.

Documented null results are first-class outcomes for all four claims.

North-star demonstration (V6 era): cross-source conflict surfacing over real public corpora —
e.g. a guideline recommendation versus a PMDA package-insert contraindication — traced from
Japanese source spans through IR and named SMT assertions to solver cores, replayable from
content hashes alone. Behind it sits an asymptotic ideal: ever more minimal admitted mapping and
axiom sets representing ever more clinical knowledge — a single global axiom in the unreachable
limit — which orients compactness and autoresearch optimization (`G-MDL`) while staying outside
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

Sources of truth, in order: user instructions > AGENTS.md > this spec > `.agent/roadmap.md`
(build plan) > `.agent/memory.md` (lessons). Sessions load §0–§2 plus the reading slice their
roadmap unit names; wider loading is reserved for spec-maintenance sessions.

Unit discipline:

- One roadmap unit = one conceptual deliverable + one gate command, finishable and committable in
  a single session with margin. Calibrate from neighbouring units and the sizing lessons in
  memory; pre-split units that stack a crate foundation, a writer-inverse, a recursive type
  family, or an algorithm plus a second authored artifact.
- Build exactly the unit's deliverable; choose the simplest implementation that passes the gate.
  Record genuine future needs as roadmap candidates for the unit that will consume them.
- Every Rust unit runs `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`, and
  its gate before staging.
- Close each cohesive piece of work with one scoped commit (AGENTS.md); write non-ASCII commit
  messages to a file and commit with `git commit -F <path>`.

Working style:

- When you have enough information to act, act; bring contract-changing decisions, destructive
  actions, and genuine scope changes to the user, and proceed on everything else.
- Audit every progress claim against a tool result from the current session; report failures with
  their output, and state verified results plainly.
- Milestone-closing reviews audit the whole milestone in a dedicated review session. Plan
  sessions use separate read-only review passes when useful. All mutations land in the main
  session.
- Record transferable lessons in `.agent/memory.md` when they generalize beyond the current unit;
  update or delete entries that have drifted.
- Lead final reports with the outcome, in plain sentences a reader without your working context
  can follow.

Spec evolution: the spec grows in place. When a milestone closes (its closing review lands), the
plan session that opens the next milestone is an elaboration session while that milestone's
contract section is still compact: expand it into full normative text (workflow-driven; mine
`docs/` and the archives through read-only review passes), present the diff to the user for
review, then seed
`.agent/roadmap.md` with the milestone's header and units. Elaboration sessions may also amend
earlier sections when implementation evidence justifies it; contract-affecting amendments reach
the user before any unit consumes them. Acceptance sessions mark the milestone header in the
roadmap with the evidence run id and add the local tag `accept/v<n>`.

Normative language: declarative present tense states binding contract. SHOULD marks a strong
default whose alternative is recorded in a registry, manifest, or gate evidence. MAY marks
options. Versions of packages, solvers, models, and tools live in lockfiles and manifests; prose
names only stable public standards.

## §2 Build plan

Intent: prove the thesis through vertical slices, each ending in a runnable artifact, instead of
assembling the full harness before the first end-to-end result.

| Stage | Deliverable | Proof |
| --- | --- | --- |
| V1 spine | Layered pipeline end-to-end on synthetic Japanese fixtures: extract → segment → normalize → assemble → compile → verify; one deontic contradiction found, one null result documented, full trace, deterministic replay. Pure Rust. | `ckc run --experiment exp.v1_spine` + §8 checklist |
| V2 comparison | Direct-formalization baseline pipeline; reuse/compactness/hash-convergence/conflict metrics; metamorphic variant fixtures; ranked comparison report. First thesis measurement (claim 1; claim 3's optimization objective via the compactness frontier). | `ckc run --experiment exp.v2_compare` + §9 acceptance |
| V3 weak-model PoC | Translation-route comparison under a weak local model (laptop CPU, grammar-constrained, recorded I/O): six routes (§10 table) scored on the V2 evaluator (claim 2); plus the build-once amortization experiment (claim 3). | `ckc run --experiment exp.v3_routes` / `exp.v3_amortize` + §10 |
| V4 autoresearch PoC | Bounded autoresearch loop (§11) over declared surfaces against a locked evaluator, optimizing lift, reuse, and coverage; full attempt ledger; driver-portable — local driver for acceptance, agent-session driver defined (claim 4). | `ckc research loop --experiment exp.v4_loop` + §11 |
| V5 sources | Public corpus ingestion: fetch/cache, permission records, real Minds/J-STAGE HTML+PDF extraction, tables and DecisionTable IR, MEDIS-anchored terminology, e-PI XML source family, drift checks. | §12 contract, elaborated at V4 acceptance |
| V6 expansion | Registry-driven growth: retrieval, richer rule semantics, additional solvers/targets, corpus scale, matrix scale-out, the cross-source flagship experiment, candidate DSLs beyond the PoC. | §13 principles, elaborated per candidate |

Scope note: V1–V4 are the current PoC horizon; V5–V6 stay in this file as compact forward
contracts so PoC decisions remain production-compatible.

Roadmap protocol: `.agent/roadmap.md`, consumed by the session command, carries one milestone at
a time: a header stamped with the commits that open (`plan`) and close (`review`) it, over an
ordered unit checklist whose completed items record context usage and commit hash; closed
milestones persist as bare headers. The plan session that opens a milestone authors its whole
checklist from the milestone's spec section; the milestone is complete when its acceptance item
passes in a dedicated acceptance session and the closing review stamps the header. Lines marked
`user-selected` get scope confirmation from the user before work begins. V1 carries a suggested
seed decomposition in §8.8.

Conservation rule: capabilities deferred from spec03 remain represented — each appears in a
milestone contract (§9–§13), the registry backlog (§14), or a gate (§15). Elaboration sessions
check deferred items against this rule as the sole scope source.

## §3 Architecture and repository

Intent: one toolchain until evidence demands a second; durable semantics in typed Rust; every
stage boundary a validated, content-addressed artifact.

Stack: a Rust workspace (edition 2024) implements everything through V4; external engines (Z3,
the V3 local-model runtime) join as recorded subprocess adapters rather than language bindings.
V5's elaboration decides per extraction/NLP adapter whether to stay Rust or admit a `uv`-managed
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

Pipeline shape (V1–V2; later stages splice in without reshaping):

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

Repository layout (target state; built up by the V1 units):

```text
.
├── SPEC.md  AGENTS.md  LICENSE  .gitignore
├── Cargo.toml  Cargo.lock
├── crates/{ckc-core,ckc-smt,ckc-cli}/
├── corpus/{fixtures,lexicon,gold}/        # committed, license-clean
├── registry/                              # corpora.yaml candidates.yaml experiments.yaml at V1;
│                                          # grows per milestone (§14)
├── docs/                                  # research compendium (§14), mined during elaboration
├── runs/                                  # gitignored run outputs
└── .agent/{memory.md,roadmap.md}
```

CLI (V1 surface; later milestones extend):

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
and prior art survive spec evolution. §4.1–§4.3 match `archive/spec03`'s implementation
(`crates/ckc-core/src/{id,strings,canon,hash}.rs` there) byte-for-byte — rebuild against it
(§8.7).

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
| `Outcome` | `ok residual ambiguity incoherence unsupported invalid`; severity order `invalid > incoherence > unsupported > ambiguity > residual > ok` | V1 |
| `Origin` | `human_authored ai_assisted ai_generated adapter_generated deterministic_compiler` | V1 |
| `Authority` | `source_authority mechanical_authority evidence_discovery_only admitted_authority compiler_authority verifier_authority view_only` | V1 |
| `BindingStatus` | `exact synonym ambiguous unmapped` | V1 |
| `Direction` | `for against contraindicate require permit avoid` | V1 |
| `ClaimTier` | `s0_replayable s1_admitted s2_research_evidence s3_clinical_regulatory` | V1 |
| `ReviewClassification` | `candidate residual ambiguity incoherence replay_failure documented_null_result` | V1 |
| `AttemptClassification` | `improved equivalent dominated regression invalid unsupported timeout crash null_result near_miss unreproducible unauthorized gate_required` | V4 |
| `PromotionDecision` | `promote reject quarantine defer_gate request_replay` | V4 |
| `PromotionScope` | `run_local registry_status` | V4 |

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

| Object | Contract (V1 unless tagged) |
| --- | --- |
| `ClinicalSegment` | CQ, recommendation, evidence, exception, definition, table-row, or metadata segment with region refs. |
| `TerminologyBinding` | Mention → concept binding: `system` (V1: `ckc.lex`), code, status (BindingStatus), alternatives, region refs. |
| `ClinicalStatement` | Normalized population, condition, action, modality, strength (`strong\|weak`), certainty (`high\|moderate\|low\|very_low`), exceptions, source refs; comparator/outcome/temporal slots optional at V1. |
| `Action` | Action kind + target concept + discriminating slots (V2) + normalized target key. |
| `ContextExpr` | Finite DNF over atoms: concept predicate, negated concept predicate, quantity interval; V2 adds slot equality and temporal interval (difference-logic) atoms. |
| `NormRule` | `rule_id, context, direction, action, strength, source_region_ids` + optional at V1 `certainty, exception_refs`; exceptions compile to negated context conjuncts, their regions joining `source_region_ids`. |
| `FactualRule` (V2) | Context → factual consequent, strictness. |
| `DecisionTable` (V5) | Input variables, units, rows, guards, outputs, source rows; DMN-style overlap semantics. |
| `IRBundle` | The five layers below + reusable component records + assumptions + diagnostics + per-layer and whole-bundle structural hashes. |
| `CompiledArtifact` | Target id, logic, query plan, query bodies, named-assertion records (assertion id → rule ids → region ids), diagnostics. |
| `VerifierResult` | Per-query status (§6 categories), model or unsat core, solver identity, diagnostics. |
| `TraceBundle` | Derivation DAG + claim-evidence rows; V2 adds reuse/compactness graphs. |
| `LineageIndex` | Query index: artifact/finding ↔ source spans ↔ rules ↔ assertions ↔ verdicts ↔ report. |
| `RunPlan` | Experiment id, fixture groups, pipeline(s), seed, budget; canonical bytes hashed into the manifest. |
| `RunManifest` | Run plan hash, git commit, toolchain/lockfile/corpus/lexicon hashes, environment profile, solver identity, output hashes. |
| `Report` | report.json (canonical) + report.md (derived view): findings, null results, diagnostics, metrics (V2+), wording per §0. |

IR layers in one `IRBundle` per document:

| Layer | Content |
| --- | --- |
| `DocIR` | Layout-preserving text/table view over SourceGraph refs with extraction diagnostics. |
| `SegmentIR` | ClinicalSegments. |
| `ClinicalIR` | ClinicalStatements + TerminologyBindings (+ CQ/PICO/EtD slots, optional V1). |
| `NormIR` | NormRules (+ FactualRules V2, DecisionTables V5). |
| `FormalIR` | Target-independent constraints, normalized actions/contexts, contradiction-query plan. |

IR invariants:

```text
Every reusable action, condition, population, concept, rule, and constraint has a stable Id and a
normalized structural hash; component records list use sites.
IRBundle validates (grounding, references, policy completeness) before compilation.
Assumptions and uncertainty are explicit payload fields.
Layered pipelines expose component reuse metadata; V2 metrics consume it.
```

Lexicon: `corpus/lexicon/ja_core.yaml` is the V1 terminology and modality authority
(system `ckc.lex`): concept entries (id, surface forms, optional interval semantics such as
成人 → `age >= 18`), action verbs, modality phrases mapped to (direction, strength) — e.g.
推奨する → (`for`, strong); 提案する/考慮してもよい → (`for`/`permit`, weak); 禁忌/投与しないこと →
(`contraindicate`, strong); 推奨しない → (`against`, strong); 提案しない → (`against`, weak) —
and certainty phrases (エビデンスの確実性:中 → `moderate`) feeding `certainty` when present.
Versioned by content hash in every manifest. Binding statuses: `exact`/`synonym` satisfy concept
demands (after representative normalization); `ambiguous` emits
`Ambiguity(terminology_ambiguous)` and `unmapped` emits `Residual(terminology_unmapped)` when one
concept is required. External terminologies (MEDIS masters first: license-clean, MHLW-designated)
join at V5 as additional systems behind the same TerminologyBinding contract.

Semantic policy invariants:

```text
Action sameness = same action kind + terminology-representative target + (V2) discriminating
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
  unsat core naming the contributing assertions; sat -> documented null result. V2 conflict
  kinds extend Q2 with threshold, slot, and factual constraints.
```

Conflict kinds (stage = first milestone that detects them):

| Kind | Stage | Idea |
| --- | --- | --- |
| `context_compatibility` | V1 | Finite context overlap over concept and interval atoms. |
| `normalized_action_sameness` | V1 | Eligibility via normalized action keys. |
| `deontic_direction_conflict` | V1 | Opposed direction groups under satisfiable shared context. |
| `numeric_threshold_empty_intersection` | V2 | Same action+direction, disjoint quantity/temporal intervals. |
| `strict_factual_contradiction` | V2 | Strict factual consequents jointly inconsistent. |
| `terminology_incoherence` | V2 | Functional key collision or mutually exclusive mapping. |
| `table_value_disagreement` | V5 | Overlapping table guards, incompatible outputs. |
| `source_metadata_disagreement` | V5 | Singleton metadata values disagree after normalization. |
| `gloss_drift` | V5 | Rendered view diverges from semantic payload. |
| `replay_or_certificate_failure` | V1 | Replay mismatch or certificate check failure. |
| `package_insert_vs_guideline_conflict` | V6 | Cross-source flagship (e-PI fixtures registered). |

SMT profile:

```text
Target: SMT-LIB 2 text artifacts, embedded in CompiledArtifact payloads and materialized
byte-identically under groups/<gid>/smt/ for solver consumption.
Logic: narrowest sufficient logic, recorded per query; V1 default QF_LRA (Bool constants +
linear-real interval atoms). V2 adds difference-logic temporal atoms; declared target profiles
gate anything richer, which otherwise returns unsupported_fragment.
Symbols: SMT symbols are |-quoted canonical Ids, so assertions remain self-identifying.
Every assertion that can influence a query is :named and mapped in the assertion map to IR rule
ids and source region ids; assertion ids form a.<rule_id> (polarity/factual) and ctx.<rule_id>
(context).
Emission is deterministic: sorted declarations, canonical symbol order, stable query ids. Each
query file sets its logic and required options (:produce-unsat-cores / :produce-models where
used; :print-success false).
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
query index; `ckc trace` resolves a finding to the full chain in both directions. V2 adds
component-reuse and compactness exports plus deterministic path visualizations: `trace_graph.dot`
(sorted nodes/edges) and per-finding Mermaid blocks in `report.md`, rendering the chain from
Japanese source span to solver verdict and the convergence of documents onto shared mapping
components; rendering to images is a view concern with renderer identity recorded. V4 adds
attempt-ledger rows to the trace exports (§11). The lineage index and derivation DAG subsume
spec03's mapping-hypergraph and axiom-dependency exports at fixture scale; dedicated exports
re-stage with V6 corpus scale if measurement demands them.

### §7.2 Reports

`report.json` is canonical; `report.md` is a deterministic rendering. Contents: corpus and
lexicon hashes, findings (each with conflict kind, rules, regions, quoted spans under permission
rules, assertion names, core), documented null results, a diagnostics summary (code-keyed
failure-taxonomy rollup), solver identity, replay status; from V2, raw metric rows before any
weighted ranking plus ablations; from V4, attempt-ledger summaries; from V6, matrix coverage.
Finding ids form `finding.<group_id>.<ordinal>` with ordinals in source-then-hash order (§4.1).
Report wording stays within the §0 vocabulary.

### §7.3 Metrics (V2 onward)

Metric values are exact rationals; unavailable values are omitted with a diagnostic; zero
denominators emit `not_applicable` per metric schema. Raw rows always accompany rankings. Core
metric families: reuse (component reuse rate, duplicate rate), compactness (component count,
mapping-set size versus coverage, fan-in/out, MDL proxies), convergence (normalized hash
agreement across variants), compilation (schema/compile/parse/solver pass rates), conflict
quality (precision/recall and conflict-task accuracy over fixture expectations), trace
completeness, determinism (hash stability), lift (per-metric route-versus-baseline deltas over
identical fixtures: layered-minus-direct from V2, model routes from V3), route quality
(schema-valid rate, admission rate, repair count, recorded-call counts, k-sample convergence;
from V3), amortized coverage (share of fresh-document semantics produced deterministically from
admitted mappings, with zero apply-phase model calls; from V3), and loop outcomes (from V4).

### §7.4 Diagnostics

Every diagnostic carries a stable code, a structured payload, region/artifact refs, and maps to
exactly one Outcome. V1–V2 code set:

```text
extraction_uncertain table_structure_uncertain span_grounding_missing segmentation_boundary_error
terminology_unmapped terminology_ambiguous terminology_incoherent semantic_slot_missing
missing_policy incompatible_policy_rows unsupported_ir_fragment schema_invalid compiler_error
target_parse_error solver_timeout solver_unknown solver_execution_failure process_crash
trace_incomplete replay_mismatch replay_identity_unsupported deferred_gate_required
false_positive_conflict false_negative_conflict metamorphic_instability
```

V3 adds model-route codes (`ai_schema_violation`, `ai_hallucinated_source`,
`repair_limit_exceeded`); V4 adds loop/budget/surface codes (`unauthorized_surface_edit`,
`budget_exhausted`); V5 adds source/permission/drift codes; each is defined in its milestone
section at elaboration time.

## §8 V1 — Spine (normative)

Intent: the smallest complete instance of the thesis machinery — one layered pipeline, real
Japanese text shapes, a real solver, full trace, deterministic replay. Everything later is
measured against this spine, so its contracts are exact.

### §8.1 Scope

Pipeline `pipe.layered_ckcir_to_smt` over synthetic fixtures; deterministic throughout
(`runtime_ai: false` is the standing V1–V2 condition; model artifacts first appear under §10
contracts at V3). Experiment `exp.v1_spine`.

### §8.2 Fixtures

Committed under `corpus/fixtures/` as minimal well-formed HTML (headings, paragraphs, one list,
one small table) with `registry/corpora.yaml` entries; origin `ai_generated`, authority
`source_authority` on admission, provenance `synthetic` — a working example of
admission-over-proposer authority.

| Fixture | Content | Role |
| --- | --- | --- |
| `fixture.v1_guideline_a` | Minds-style synthetic guideline: CQ + recommendation 「成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する(強い推奨)」 with exception 「ただし、重度腎機能障害のある患者を除く」, plus one definitions table and an evidence list for layout coverage. | Recommendation source. |
| `fixture.v1_guideline_b` | Synthetic companion document: 「成人の敗血症患者のうち、妊娠中の患者には抗菌薬Aを投与しないこと(禁忌)」. | Overlap + contraindication → expected contradiction with A. |
| `fixture.v1_control` | Synthetic document: 「小児(18歳未満)の敗血症患者には抗菌薬Aは禁忌である」. | Age intervals disjoint with A → expected null result. |

Fixture groups in `exp.v1_spine`: `group.v1_conflict = [a, b]` expecting one
`deontic_direction_conflict` finding; `group.v1_null = [a, control]` expecting
`semantic_no_conflict` + `documented_null_result`. Expected outcomes live in
`corpus/gold/v1_expected.yaml`, asserted by the acceptance tests, one entry per fixture group:

```yaml
- group_id: group.v1_conflict
  expected_outcome: semantic_contradiction
  expected_conflict_kind: deontic_direction_conflict
  expected_core: [a.rule.a.cq1.r1, a.rule.b.contra1]   # compared as a set
- group_id: group.v1_null
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

### §8.4 Registries at V1

`registry/corpora.yaml` (fixtures above), `registry/candidates.yaml` (the pipeline and its stage
components with ids, kinds, determinism, input/output artifact kinds), `registry/experiments.yaml`
(`exp.v1_spine`: fixture groups, pipeline, seed, budget, expected-outcome ref). `ckc registry
check` validates all three and verifies each pipeline's stage components chain: every stage's
declared input artifact kinds are produced by its predecessors.

### §8.5 Acceptance checklist

1. `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and
   `cargo test --workspace` pass.
2. `ckc registry check` passes.
3. `ckc run --experiment exp.v1_spine --out runs/v1` completes with outcome `ok`, emitting the
   §8.3 artifact set with every accepted artifact passing strict canonical read (enforced by a
   workspace test over the run directory).
4. Every named assertion in each `compiled.json` maps to IR rule ids and source region ids.
5. `group.v1_conflict` yields `semantic_contradiction` with an unsat core naming assertions
   derived from both documents.
6. `group.v1_null` yields `semantic_no_conflict` and a `documented_null_result` entry in the
   report, evidenced by the Q1 unsat (disjoint age intervals).
7. `ckc trace --run runs/v1 --finding <finding-id>` prints the complete chain: source spans →
   segments → statements → rules → named assertions → solver verdict → report finding.
8. `ckc replay runs/v1` reports matching canonical content hashes for all accepted artifacts.
9. `report.md`/`report.json` carry findings, the null result, diagnostics, solver identity, and
   §0-vocabulary wording, with quoted Japanese spans resolving to fixture bytes.

### §8.6 Worked thread (docA × docB)

Source span (docA): 「成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する」 + exception
span 「ただし、重度腎機能障害のある患者を除く」.

NormRule (canonical payload: fields byte-sorted, atoms as §4.3 tagged unions, conjunct sets
sorted by canonical_sort_key; sibling ids disambiguate per §4.1):

```json
{"action":{"key":"act.administer:drug.abx_a","kind":"act.administer","target":"drug.abx_a"},
 "context":{"any":[{"all":[
   {"tag":"concept","value":"cond.sepsis"},
   {"tag":"concept_negated","value":"cond.renal_severe"},
   {"tag":"interval","value":{"ge":"18","var":"q.age_years"}}]}]},
 "direction":"for","rule_id":"rule.a.cq1.r1",
 "source_region_ids":["region.a.cq1.rec","region.a.cq1.exc"],
 "strength":"strong"}
```

docB yields `rule.b.contra1`: context `cond.sepsis ∧ age ≥ 18 ∧ cond.pregnancy`, direction
`contraindicate`, same action key → pair eligible.

Q1 `q.v1_conflict.pair1.overlap` (QF_LRA):

```smt2
(set-logic QF_LRA)
(set-option :print-success false)
(set-option :produce-models true)
(declare-const |q.age_years| Real)
(declare-const |cond.sepsis| Bool) (declare-const |cond.renal_severe| Bool)
(declare-const |cond.pregnancy| Bool)
(assert (! (and |cond.sepsis| (>= |q.age_years| 18) (not |cond.renal_severe|))
           :named |ctx.rule.a.cq1.r1|))
(assert (! (and |cond.sepsis| (>= |q.age_years| 18) |cond.pregnancy|)
           :named |ctx.rule.b.contra1|))
(check-sat)            ; sat
(get-model)            ; witness model recorded
```

Q2 `q.v1_conflict.pair1.deontic`: polarity literals on the shared action (overlap witnessed by Q1):

```smt2
(set-logic QF_UF)
(set-option :print-success false)
(set-option :produce-unsat-cores true)
(declare-const |pos:act.administer:drug.abx_a| Bool)
(assert (! |pos:act.administer:drug.abx_a|        :named |a.rule.a.cq1.r1|))
(assert (! (not |pos:act.administer:drug.abx_a|)  :named |a.rule.b.contra1|))
(check-sat)            ; unsat
(get-unsat-core)       ; recorded as the canonical set {a.rule.a.cq1.r1, a.rule.b.contra1}
```

VerifierResult: `semantic_contradiction`, core `[a.rule.a.cq1.r1, a.rule.b.contra1]`. Report
finding `finding.group.v1_conflict.1` cites both rules, their regions, the quoted spans, the core, and
classifies as `deontic_direction_conflict`, claim tier `s1_admitted`, wording `synthetic fixture
measurement`. The control group's Q1 is unsat (`age >= 18` vs `age < 18`), closing as
`documented_null_result`. `ckc trace` walks the chain from 「妊娠中の患者には…投与しないこと」 to
the core and back.

### §8.7 Prior art

`archive/spec03` holds reference implementations for the §4 kernel — `core-ids`
(Id/Hash/Rational), `core-strings` (seven policies),
`core-canon-writer/collections/unions/reader/hash` (canonical bytes + hashing) — byte-compatible
with §4.1–§4.3. `archive/spec02` holds a canonical serializer, content-addressed store, and
closure/certificate patterns. Consult them via `git show archive/specNN:<path>` or read-only
review passes; this main rebuilds the code fresh.

### §8.8 Seed decomposition (sizing aid; the roadmap is authoritative)

```text
core-ids: ckc-core crate + workspace wiring + Id/Hash/Rational value types (§4.1).
core-strings: the seven §4.2 string policies as deterministic normalizers.
core-canon-writer: canonical JSON writer core (§4.3 object/optional/integer/rational rules).
core-canon-collections: canonical arrays, sets, and maps over the writer core.
core-canon-unions: tagged-union and fieldless-enum emission.
core-canon-reader: strict canonical reader as the writer's inverse (full window; schedule solo).
core-canon-hash: content_hash + canonicalization_policy_hash over canonical payload bytes.
core-enums-envelope: §4.4 enums + envelope + total result types + §4.6/§7.4 event and
diagnostic record types.
core-grounding: §4.5 SourceGraph/Span/Anchor/Region types + invariants.
core-ir.1: DocIR+SegmentIR layers + per-layer hash pattern.
core-ir.2: ClinicalIR+NormIR (statements, bindings, Action, ContextExpr, NormRule).
core-ir.3: FormalIR + IRBundle assembly + bundle validation.
core-plans: RunPlan/RunManifest/replay-manifest types + canonicalization.
core-registry: corpora/candidates/experiments entry types + validation.
fixtures-v1: three fixture documents + lexicon ja_core.yaml + corpora entries + expected outcomes.
stage-extract: HTML → SourceGraph (parser dep; tables/lists/sections).
stage-segment: rule-based segmentation.
stage-normalize.1: lexicon load + bindings + statements.
stage-normalize.2: NormRule derivation (guards, exceptions, intervals).
smt-emit.1: ckc-smt crate foundation + CompiledArtifact/VerifierResult types, round-trip tested.
smt-emit.2: eligibility scan + contradiction-query planning over FormalIR.
smt-emit.3: deterministic SMT emission + assertion map.
smt-verify: Z3 invocation + verdict/core/model parsing into VerifierResult.
cli-runner.1: ckc-cli crate foundation + CLI dispatch + registry check.
cli-runner.2: run orchestration over stages + run layout + total-result aggregation + JSONL
event/diagnostic emission + the strict-canonical-read run-directory test (§8.5 item 3).
cli-runner.3: trace bundle + lineage index + ckc trace.
cli-runner.4: report rendering + manifests + ckc replay.
acceptance-v1 per §1 protocol; the closing review stamps the milestone header.
```

## §9 V2 — Comparison and metrics (normative)

Intent: the first thesis measurement — layered versus direct, with reuse and convergence
quantified on a corpus designed to exercise them.

Scope:

- `pipe.direct_rule_to_smt`: extract → segment → direct phrase-normalization → FormalIR → SMT,
  bypassing shared ClinicalIR/NormIR component reuse; unused stages emit pass-through artifacts
  (outcome `ok`, payload marker `not_applicable`) under the same envelope rules.
- Fixture growth: 4–6 additional synthetic documents sharing populations/actions/conditions
  across documents (reuse pressure), plus deterministic metamorphic variants of V1 documents
  (punctuation, kana/kanji, section order) committed as mutation fixtures with declared
  provenance, plus threshold-conflict and factual-conflict cases for the V2 conflict kinds.
- Component store: run-scoped index of reusable components keyed by normalized structural hash;
  layered pipeline records hits/misses; `component_reuse_graph.json` and
  `compactness_frontier.json` join the trace exports — the frontier doubles as the
  mapping-minimization view (claim 3's optimization objective, measured deterministically here).
- Path visualizations per §7.1 (per-finding chain; cross-document component convergence).
- Metrics per §7.3 over both pipelines; the per-metric layered-minus-direct deltas are the
  staged-pipeline lift measurement; `candidate_diff.json` compares segment, binding, rule,
  assertion, verdict, and metric levels; `ranking.csv` + `score_breakdown.json` with raw rows.
- Frozen-measurement record: the run manifest freezes the V2 evaluator identity — fixture,
  gold, lexicon, and metric-code hashes (`evaluator_lock.json` extends this identity with full
  semantics in V4).
- V2 conflict kinds (§6 table) implemented: `numeric_threshold_empty_intersection`,
  `strict_factual_contradiction`, `terminology_incoherence`; ambiguous/unmapped binding paths
  exercised by fixtures.
- Deterministic ablations reported alongside metrics: `exceptions_off`,
  `terminology_grounding_off`.
- `registry/methods.yaml` seeded from the `docs/` compendium (§14).

Acceptance sketch (finalized when V2's roadmap units are authored): both pipelines run
`exp.v2_compare` over all fixture groups; metrics emit exact-rational raw rows; hash-convergence
asserts identical component hashes across metamorphic variants for the layered pipeline; the
comparison report ranks pipelines with raw rows visible; path and reuse visualizations emit with
deterministic bytes; expected conflict/null outcomes hold per gold; replay holds for both
pipelines; `candidate_diff.json` is complete.

## §10 V3 — Weak-model translation PoC (contract; elaborate at V2 acceptance)

Intent: measure claims 2–3 on this laptop — IR configuration as the variable, a weak local model
as the constant, the V1–V2 evaluator as the instrument. The model stays in the loop for every
route; the route axis decides how much it is trusted with, and the evaluator turns "more reliable
translation" into locked raw rows instead of anecdote.

Committed direction:

- Model harness: a llama.cpp-family local runtime invoked as a recorded subprocess (the Z3
  pattern): greedy decoding with a fixed seed (k-sample convergence draws k recorded samples via
  per-sample seeds), grammar-constrained output via GBNF/JSON-Schema compiled from the §4/§5
  type schemas — the committed `schemas/` export and `registry/{schemas,prompts}.yaml` land
  here (§14) to feed grammars and prompt templates. Model identity, quantization, and runtime version live in
  manifests; the baseline SHOULD be a small Japanese-capable instruct model (sub-4B, CPU
  quantized) weak enough that direct-route failures are common — that headroom is the
  experiment. Model I/O records as fixture artifacts (origin `ai_generated`, authority
  `evidence_discovery_only`, prompt-template hashes in manifests); recorded bytes replay
  deterministically; live calls run only under an explicit experiment flag with full recording.
- Routes (translation configurations; concrete existing-IR schemas picked at elaboration from
  `docs/`, registered as §8.4 candidate entries):

| Route | Shape |
| --- | --- |
| `route.direct_smt` | Model emits SMT-LIB text directly — the weak baseline. |
| `route.single_ir` | Model fills one existing-IR-shaped schema (e.g. DMN-style condition/action rows); deterministic compile from there. |
| `route.stacked_ir` | Model fills a stack of existing IR forms (e.g. PICO frame → rule rows); deterministic compile. |
| `route.ir_hop_chain` | Model translates across a chain of adjacent, deliberately similar IR dialects — several small constrained hops, each a minimal semantic delta — testing whether short hops tame non-determinism better than one long jump. |
| `route.ckc_layered` | Model fills CKC layers stage by stage (segment → statement → rule), each grammar-constrained; the §6 compiler takes over. |
| `route.ckc_dsl` | Model emits a compact project-born DSL under a grammar mask; deterministic parse → IR → compile. |

- Every route registers its schemas/grammars and a deterministic bridge into the §6 profile,
  keeping conflict-task scoring identical across routes; V3 diagnostic codes land per §7.4.
- Scoring: every route runs `exp.v3_routes` under one frozen-measurement identity (per §9);
  model output passes the same §4 admission checks as any artifact; §7.3 route-quality, lift,
  conflict-task accuracy, and k-sample convergence metrics emit as raw rows before ranking.
- Amortization experiment (`exp.v3_amortize`, claim 3): fixture set A builds mappings and
  admitted entries join the lexicon/component store; fixture set B (fresh documents sharing
  components) then runs `runtime_ai: false` (§8.1). Metrics: deterministic coverage of B,
  accuracy versus gold, mapping-set size versus coverage on the compactness frontier, and
  apply-phase model-call count (zero) against a model-per-document baseline. Apply-phase path
  graphs (§7.1) contain zero model nodes — the runtime removal made visible.
- Wording: route results are locked measurements (s0/s1 raw rows); runtime-oracle fidelity
  claims sit behind `G-RUNTIME-ORACLE`.

Acceptance themes (finalized at elaboration): all registered routes execute over identical
locked inputs; recorded model I/O replays byte-stably; the lift table and amortization report
emit with raw rows first; expected conflict/null outcomes hold per gold; §0 vocabulary holds.

## §11 V4 — Autoresearch PoC (contract; elaborate at V3 acceptance)

Intent: claim 4 — `ckc research loop --experiment exp.v4_loop` runs a bounded
propose → patch → run → score → classify → promote/reject → replay → ledger cycle that improves
claims 1–3's objectives under an immutable evaluator. The PoC runs on laptop budgets; the loop
contract is built to outgrow them.

Committed direction:

- `EvaluatorLock` (`evaluator_lock.json`, extending the §9 V2 identity) materialized before
  attempts: fixture/gold/schema/metric/evaluator-code/toolchain/seed/budget hashes, immutable
  per experiment; per-attempt `attempt_run_lock` records evaluator-lock, candidate-graph (the
  resolved §8.4 pipeline+config identity hash), and patch/workspace hashes.
- Declared editable surfaces for the PoC: lexicon entries, prompt templates, route/DSL
  configuration (grammar included). The evaluator stays outside every candidate's editable
  surfaces; an attempt editing locked surfaces classifies as `unauthorized` (diagnostic
  `unauthorized_surface_edit`) and stays unscored.
- Objectives: §7.3 lift, route quality, amortized coverage, and reuse — promotion requires
  (improvement on at least one objective, or frontier membership), every objective within
  regression thresholds, schema validity, trace completeness, and replay success.
- Ledger: every attempt, whatever its AttemptClassification (§4.4), lands in append-only
  `experiment_ledger.jsonl` (+ derived CSV/MD) with a run-local PromotionDecision (§4.4);
  locally promoted attempts replay deterministically.
- Budgets: max attempts/promotions/failures, wall-clock, and token counters per attempt and per
  loop; exhaustion stops the loop with `Residual(budget_exhausted)`, preserving completed and
  partial evidence.
- Authority: run-local promotion changes ledgers/reports only. Registry/status promotion carries
  from/to status, evidence and replay hashes, rollback, and applicable gates (`G-SELF-IMPROVE`);
  evaluator-identity changes (fixtures, gold, schemas, metrics, evaluator code, thresholds)
  score only in a separate `G-EVALUATOR-MIGRATION` experiment.
- Mapping-gap repair (council pattern): unmapped/ambiguous residuals from new documents seed
  proposals; several independent proposer agents draft mapping deltas, and a convergence
  criterion — agreement over normalized proposal hashes — gates patch admission; dissenting
  proposals stay in the ledger.
- Loop drivers: the loop contract (lock, surfaces, budgets, ledger, admission) is
  driver-independent, with the driver an ExperimentPlan field recorded in manifests.
  `driver.local` — this PoC's acceptance driver — runs recorded local models on the laptop.
  `driver.agent_session`, a §8.4 candidate entry, runs proposer/council/patch steps as supervised
  agent sessions (repo-local command documentation or scripts, authored at this milestone's
  elaboration), with API cost in the budget fields; it ships authored and registered, exercised on
  user request. Long-horizon loops run on the agent driver when scale demands; evaluator locks,
  admission, and ledgers stay identical across drivers.
- Standing long-run objectives: route/IR-combination search over the `registry/methods.yaml`
  universe (§14) — existing formalisms and invented DSLs; the claim-2 configuration space is
  combinatorial — and mapping-set minimization toward the §0 asymptotic ideal, under `G-MDL`
  for any calibrated minimality claim.
- Scale-out — `ExperimentPlan` matrices with compatibility filters, pairwise/fractional designs,
  Pareto/beam narrowing, and coverage classification (untested, skipped-incompatible,
  unsupported, failed, dominated, equivalent, Pareto-front, promising) — extends this contract
  when candidate spaces outgrow the PoC (V6).

Acceptance themes: the loop executes on `driver.local` within budgets over at least two
surfaces, with the driver named in the manifest; the ledger holds at least one valid scored
attempt and one rejected or dominated attempt; an unauthorized-surface patch is classified and
stays unscored; at least one locally promoted attempt replays; ledger summaries emit as CSV/MD.

## §12 V5 — Public sources (contract; elaborate at V4 acceptance)

Intent: the spine, comparison, and admitted translation routes run end-to-end on real public
Japanese guideline material with permission-aware caching and richer extraction.

Committed direction:

- Fetch/cache: content-addressed store under `corpus/raw/` (gitignored), resumable, with
  `PermissionRecord` per source (rights holder, access ref, license label,
  `redistribution_status ∈ redistributable|reconstructable|restricted_internal_only`, allowed
  artifact classes) and deterministic redaction policy; blocked exports emit
  `Residual(permission_limited)` and continue. New source families/export classes trigger
  `G-SOURCE-PERMISSION`.
- Source families: Minds-style guideline HTML/PDF (full text treated internal-only with
  offsets/hashes/derived labels exportable; spans quoted in reports only where permitted),
  J-STAGE/JATS XML, and PMDA e-PI XML (license-clean structured sections — 禁忌/効能/用法 — and
  the future cross-source counterpart). `registry/source_processors.yaml` declares per-family
  adapters, stages, permission behavior, drift policy, diagnostics.
- Extraction: real HTML/XML parsing extended to PDF text/layout and table structure with
  uncertainty diagnostics; DecisionTable IR + `table_value_disagreement`; gold segment/statement
  labels for at least one real fixture; extractor promotion claims trigger `G-EXTRACTOR-ADAPTER`.
- Terminology: MEDIS standard masters (病名/HOT) as the first external systems behind the
  TerminologyBinding contract; version-pinned snapshots; license-encumbered vocabularies
  (SNOMED CT, MedDRA/J, LOINC) stay registry-listed until licensing evidence exists.
- Drift: source hash changes emit `source_drift.json` and mark dependent scores stale.
- Boundary: the committed schemas exported since V3 govern any cross-language boundary; the
  Rust-vs-Python adapter decision per §3 is made and recorded here.

## §13 V6 — Expansion (principles; elaborate per candidate)

Intent: registry-driven growth; every candidate enters behind benchmark evidence and applicable
gates.

| Candidate | Adoption trigger |
| --- | --- |
| Sparse retrieval (BM25); license-clean dense/rerank models | Corpus scale demands navigation. |
| Richer rule semantics: defeasible priorities/superiority, ASP/Clingo, argumentation | Exception-as-context-conjunct measurably under-fits real guidelines. |
| Additional targets: cvc5 certificates → Lean/Isabelle replay; DMN table semantics; Alloy/TLA+ pipeline properties; e-graph canonicalization | Verifier-portfolio, table-semantics, or convergence evidence demands them. |
| Corpus-scale sweeps; matrix scale-out, long-horizon agent-driver loops, IR-combination search (§11) | Candidate spaces outgrow the PoC. |
| `package_insert_vs_guideline_conflict` flagship | V5 e-PI fixtures registered. |
| DSL/CKC-GEN beyond the V3 PoC DSL: typed-hole authoring, proof export, full kernel | V3/V4 evidence favors invented IRs. |

The §2 conservation rule keeps this table in sync with `registry/methods.yaml`.

## §14 Registries and research compendium

Registry files are data, validated by `ckc registry check`, growing per milestone: V1
`corpora|candidates|experiments`; V2 adds `methods`, the method-universe catalogue seeded from
the compendium (families, aliases, candidate roles, adapter status
`v_required|v_optional|registered_backlog|gate_only`, benchmark tags, compatibility metadata);
V3 adds `prompts|schemas` (the schema export feeds V3's grammar constraints); V4 adds
`evaluators|gates` (gate evidence objects); V5 adds `source_processors|policies`; V6 adds
`indexes` with retrieval.

`docs/` is the committed research compendium behind spec04 — ten method-category deep-research
reports plus the agent-language catalogue. Registry-seeding and elaboration units mine it through
read-only review passes and cite `file §section` in registry notes; main sessions keep their
working context focused.

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
| `G-SELF-IMPROVE` | Automated registry/status promotion of accepted generators, prompts, policies, compilers, verifier adapters, metric/report code. | `SelfImprovementEvidence` |
| `G-PROB` | Probabilistic semantics affecting accepted outputs. | `ProbabilisticProfileRecord` |
| `G-WORLD-MODEL` | Latent-state/multimodal observations affecting outputs. | `WorldModelProfileRecord` |
| `G-LIVE-PATIENT` | Any patient-derived data entering CKC. | `GovernedPatientDataProfile` |
| `G-S3` | Clinical/regulatory/deployment authority claims. | `S3AssuranceEvidence` |

Gate invariants: gate evidence is replayable or explicitly marked non-authoritative; candidate
loops run inside locked experiments, with evaluator changes governed separately before any
ranking that depends on them; regulatory-framework vocabulary (assurance cases, SaMD classes,
APPI categories, SBOM fields) enters the spec only through these evidence objects when their
gates first trigger.
