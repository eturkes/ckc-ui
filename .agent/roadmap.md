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

## Next

- [ ] `user-selected` Plan session -- open M1 (SPEC §2 row; checklist §8):
  author the M1 unit checklist from its spec section and decide how the JS
  prototype maps onto the Rust contract (port / keep as reference / retire).
  Confirm the JS->Rust transition scope before any unit runs.
