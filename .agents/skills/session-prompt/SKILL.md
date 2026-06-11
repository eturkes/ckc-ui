---
name: session-prompt
description: Use only when explicitly invoked as $session-prompt to start or resume a CKC manuscript-figures work session from the task text supplied by the user.
---

# Session Prompt

Treat the invoking user message as a command with this shape:

```text
$session-prompt [TASK]
```

Task selection:
1. If the invoking message contains non-whitespace text after `$session-prompt`, use that text as the requested task.
2. If the invoking message contains no task text after `$session-prompt`, ask the user for the task before changing files.

Work in `/run/host/home/eturkes/Projects/scratch/ckc-ui`.

Load order:
1. `AGENTS.md`
2. `SPEC.md` sections needed for the requested task
3. `.agent/memory.md` if it exists

Standing project intent: CKC is a headless clinical knowledge compiler. Manuscript-figure work must present research evidence, traceability, replay, artifacts, metrics, ledgers, and gates. It must avoid clinical decision-support claims unless explicit gate evidence exists.

Current presentation artifacts: `tools/build-figures.mjs` reads ignored `runs/m2-one-shot/report.json` and writes tracked manuscript-ready SVG/PDF figures, `figures.tex`, `README.md`, `manifest.json`, and `manuscript_figures.pdf` under `figures/manuscript/`. Treat these as the active communication surface; root `index.html` is obsolete and ignored.

Closeout:
1. Verify changed artifacts with local tools.
2. Keep `.gitignore` aligned with generated outputs.
3. Commit one scoped change before final response when work is complete.
