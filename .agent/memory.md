# Agent Memory

- CKC UI framing: present a research/evidence workbench over canonical artifacts, not a clinical UI. Primary surfaces are run state, findings/null results, lineage from source span to solver verdict, artifact hashes, replay, metrics, and autoresearch ledger rows.
- Keep operating instructions grounded in tools and files actually present in this repository. Avoid carrying over tool-specific directories, fixed context-window protocols, or missing maintenance scripts unless the repo later adds them explicitly.
- Codex custom prompts under `~/.codex/prompts` are user-global. Project-local command-like workflows belong under `.agents/skills`; `$session-prompt <TASK>` is a repo skill and parses the task text from the invoking message.
- V3 UI mockup lives at `mockups/ckc-exp-v3-routes.html`; it combines `exp.v3_routes` and `exp.v3_amortize` as one evidence surface with route ranking, recorded model I/O, grammar gates, raw rows, and a zero-apply-call amortization path.
