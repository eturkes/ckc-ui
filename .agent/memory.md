# Agent Memory

- CKC UI framing: present a research/evidence workbench over canonical artifacts, not a clinical UI. Primary surfaces are run state, findings/null results, lineage from source span to solver verdict, artifact hashes, replay, metrics, and autoresearch ledger rows.
- Keep operating instructions grounded in tools and files actually present in this repository. Avoid carrying over tool-specific directories, fixed context-window protocols, or missing maintenance scripts unless the repo later adds them explicitly.
- Browser/screenshot verification caveat: `chromiumfish` is on PATH, but the 150.0.7844 cached build currently lacks `chrome_crashpad_handler`; direct headless screenshots fail before rendering. Repair/replace the browser build before relying on visual screenshots.
- Codex custom prompts under `~/.codex/prompts` are user-global. Project-local command-like workflows belong under `.agents/skills`; `$session-prompt <TASK>` is a repo skill and parses the task text from the invoking message.
- 2026-06-11 reset: old mockups, `PRESENTATION.md`, and `runs/visual-checks` were deleted after SPEC.md moved to spec04 r2 M1-M6 framing. Current UI seed is the single standalone file `mockups/ckc-spec04-start.html`; it is a compact evidence workbench over §0-§15, not implementation authority or measured output.
