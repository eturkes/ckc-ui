# Roadmap

Protocol: SPEC §2. One milestone open at a time. Header stamped with opening
(`plan`) and closing (`review`) commit hashes; ordered unit checklist; each done
unit records `NN%` context + commit hash; closed milestones persist as bare
headers. Acceptance adds tag `accept/m<n>`. `user-selected` units get scope
confirmation before work starts.

## Status: no milestone open

- No spec milestone opened or accepted -- no Rust workspace, no `accept/*` tag.
- Prior art: `tools/build-run.mjs` (JS) implements M1-M3 experiments at
  fixture-scale demo evidence (`exp.m2_shorthop` default; `exp.m3_routes` /
  `m3_compare` / `m3_coverage`), a deliberate deviation from SPEC §3's Rust
  stack; root `index.html` renders its route ranking. Detail in
  `.agent/memory.md`.

## Active initiative (user-selected, overrides Next): sophisticated IR routes

Add four sophisticated IR route configurations to the harness + registry and
surface measured `candidate_verdict_accuracy` in `index.html`. Each attacks the
stalled candidate-accuracy / zero-admission ceiling differently. One route per
session: implement, run live, rank, commit. Honesty gate for every route: any
repair / selection / feedback signal stays answer-agnostic (never reads gold
`expected`); only measured numbers reach the UI.

- [x] S1 `route.ckc_repair` -- ckc_layered base + bounded rule-stage self-repair
  loop; feedback = intrinsic schema / grounding / bridge / SMT-syntax residuals,
  attempts selected on well-formedness only (gold-coupled FP/FN residuals
  withheld). Result + commit/context stamped in `.agent/memory.md`.
- [ ] S2 `route.ckc_grounded` -- terminology / ontology binding + typecheck stage
  before lowering; targets grounding residuals at their source.
- [ ] S3 `route.ckc_ensemble` -- multiple independent IR drafts per row, then a
  reconciliation / vote pass into one before compiling.
- [ ] S4 `route.ckc_cegis` -- solver counterexample-guided repair reusing S1's
  loop infra; feedback driven by an SMT solver (needs z3; verify install first).

Per-route integration surface (S1 reference): `implementedRouteIds`, `llamaArgs`
route-args branch, `runLiveRoute` dispatch, a `runLive<Route>` runner reusing
`classifyCkcLayeredCandidate`, `registry/routes.json` entry, `exp.m3_routes`
`.routes` in `registry/experiments.json`, plus the EN + JA row in `index.html`.
Gate: `node tools/build-run.mjs --verify --live-model --experiment exp.m3_routes`
returns exit 0. `simulateRoute` (recorded mode) needs no per-route branch.

## Next

- [ ] `user-selected` Plan session -- open M1 (SPEC §2 row; checklist §8):
  author the M1 unit checklist from its spec section and decide how the JS
  prototype maps onto the Rust contract (port / keep as reference / retire).
  Confirm the JS->Rust transition scope before any unit runs.
