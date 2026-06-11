---
name: session-prompt
description: Use only when explicitly invoked as $session-prompt; with task text start that CKC task, and with no task text start the next incomplete item from .agent/session-plan.md.
---

# Session Prompt

Treat the invoking user message as a command with this shape:

```text
$session-prompt [TASK]
```

Task selection:
1. If the invoking message contains non-whitespace text after `$session-prompt`, use that text as the requested task.
2. If the invoking message contains no task text after `$session-prompt`, read `.agent/session-plan.md`, select the first queue item whose `status` is not `done`, and use that item as the requested task.
3. If every queue item is `done`, report that the plan is complete and ask the user for a new task before changing files.
4. For a selected queue item, set `status: in_progress` at session start unless it is already `in_progress`; set `status: done` only after every gate passes. Leave partial work as `in_progress` with a dated progress note. If blocked, record the exact blocker under the item.

Work in `/run/host/home/eturkes/Projects/scratch/ckc-ui`.

Load order:
1. `AGENTS.md`
2. `SPEC.md` sections needed for the requested task
3. `.agent/memory.md` if it exists

Standing project intent: CKC is a headless clinical knowledge compiler. Manuscript-figure work must present research evidence, traceability, replay, artifacts, metrics, ledgers, and gates. It must avoid clinical decision-support claims unless explicit gate evidence exists.

Current presentation artifacts: `tools/build-figures.mjs` reads ignored `runs/m2-one-shot/report.json` and writes tracked manuscript-ready SVG/PDF figures, `figures.tex`, `README.md`, `manifest.json`, and `manuscript_figures.pdf` under `figures/manuscript/`. Treat these as the active communication surface; root `index.html` is obsolete and ignored.

Active multi-session plan: `.agent/session-plan.md` contains the comparison expansion queue. No-argument task selection is determined solely by queue status.

Closeout:
1. Verify changed artifacts with local tools.
2. Keep `.gitignore` aligned with generated outputs.
3. Update `.agent/session-plan.md` and `.agent/memory.md` only with durable, non-obvious state from the session.
4. Commit one scoped change before final response when work is complete.
