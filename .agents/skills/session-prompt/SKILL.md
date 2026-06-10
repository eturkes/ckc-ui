---
name: session-prompt
description: Use only when explicitly invoked as $session-prompt to start or resume a CKC UI work session from a task argument.
---

# Session Prompt

Treat the invoking user message as a command with this shape:

```text
$session-prompt <TASK>
```

Use the text after `$session-prompt` as the requested task. If the invoking message contains no task text after `$session-prompt`, ask for the missing task before changing files.

Work in `/run/host/home/eturkes/Projects/scratch/ckc-ui`.

Load order:
1. `AGENTS.md`
2. `SPEC.md` sections needed for the requested unit
3. `.agent/memory.md` if it exists

Standing project intent: CKC is a headless clinical knowledge compiler. UI work must present research evidence, traceability, replay, artifacts, metrics, ledgers, and gates. It must avoid clinical decision-support claims unless explicit gate evidence exists.

Current UI seed artifacts: `mockups/ckc-evidence-workbench.html` is a general static CKC evidence workbench; `mockups/ckc-exp-v2-compare.html` focuses on `exp.v2_compare`. Treat both as exploratory design material, not implementation authority.

Default closeout:
1. Verify changed artifacts with local tools.
2. Keep `.gitignore` aligned with generated outputs.
3. Commit one scoped change before final response when work is complete.
