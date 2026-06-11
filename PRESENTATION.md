# CKC Human Presentation Strategy

Intent: make CKC legible to humans without weakening the project posture in `SPEC.md`. CKC is a
research evidence workbench, not a clinical decision-support product.

## Core Frame

Use this one-sentence explanation first:

```text
CKC turns guideline text into replayable formalization evidence: source spans, reusable rules,
machine checks, findings/null results, metrics, and gates.
```

The first human screen must answer three questions in this order:

1. What happened?
2. Why should I trust the result?
3. What is not being claimed?

## Presentation Spine

Prefer one narrated evidence thread over a full system diagram as the entry point:

```text
source span -> picked spans -> normalized statement -> reusable rule -> SMT assertion ->
solver verdict -> finding/null result -> trace/replay package
```

This thread is the reader's anchor. Experiments, metrics, ledgers, and gates should branch from
that anchor instead of appearing as unrelated dashboards.

## Progressive Layers

| Layer | Human question | CKC surface |
| --- | --- | --- |
| Orientation | What is this project? | Research harness boundary, claim tiers, current milestone. |
| Evidence story | What happened in one run? | One finding or documented null result with source spans and verdict. |
| Trust proof | Why believe the story? | Trace graph, artifact hashes, replay manifest, diagnostics. |
| Research question | What is being tested? | V1-V4 experiments framed as falsifiable questions. |
| Audit boundary | What claims are blocked? | §15 gates and missing-gate residuals. |
| Expansion | Where can this go later? | V5-V6 contracts only after prior evidence. |

## Reader Modes

Keep the same artifact data underneath every mode; change density and ordering only.

| Mode | Optimized answer |
| --- | --- |
| `overview` | What CKC does and why the result is bounded research evidence. |
| `research` | Which falsifiable claim the run supports or fails to support. |
| `audit` | Which exact artifacts, hashes, diagnostics, and gates control the claim. |
| `build` | Which pipeline stages, registries, and commands produced the artifacts. |

## Wording Rules

Use the §0 vocabulary: `research harness`, `candidate`, `source-grounded`, `schema-valid`,
`verifier-checked`, `replayable`, `locked measurement`, `synthetic fixture measurement`, and
`documented null result`.

Always include the boundary near findings:

```text
This is formalization-QA evidence over declared sources and locked fixtures. It is not patient-care
guidance, CDS runtime behavior, SaMD evidence, or regulatory approval.
```

## Mockup Inventory

`mockups/ckc-human-overview.html` is the digestible entry concept. Existing specialized views
remain useful drill-downs:

| File | Role |
| --- | --- |
| `mockups/ckc-evidence-workbench.html` | General evidence workbench. |
| `mockups/ckc-exp-v2-compare.html` | Layered versus direct comparison. |
| `mockups/ckc-exp-v3-routes.html` | Weak-model route and amortization evidence. |
| `mockups/ckc-exp-v4-loop.html` | Autoresearch loop ledger and locks. |
| `mockups/ckc-experiment-map.html` | One-page experiment map. |
| `mockups/ckc-ir-strata-tree-plain-concept.html` | Plain-language IR extraction concept. |

## Design Invariants

- Start from a concrete evidence story before showing the full roadmap.
- Frame versions as questions: "Can the chain close?", "Does layering beat direct?", "Can mappings
  remove runtime model calls?", "Can the loop improve under a locked evaluator?"
- Keep raw rows and null results visible; never show a rank without the evidence rows behind it.
- Make trace, replay, diagnostics, and gate state first-class controls, not footnotes.
- Use synthetic or permission-safe examples unless source permission evidence exists.
