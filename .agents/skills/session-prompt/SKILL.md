---
name: session-prompt
description: Use only when explicitly invoked as $session-prompt with task text; start that CKC task.
---

# Session Prompt

Treat the invoking user message as a command with this shape:

```text
$session-prompt [TASK]
```

Task selection:
1. If the invoking message contains non-whitespace text after `$session-prompt`, use that text as the requested task.
2. If the invoking message contains no task text after `$session-prompt`, report that an explicit task is required before changing files.

Work in `/run/host/home/eturkes/Projects/scratch/ckc-ui`.

Load order:
1. `AGENTS.md`
2. `SPEC.md` sections needed for the requested task
3. `.agent/memory.md` if it exists

Standing project intent: CKC is a headless clinical knowledge compiler. Presentation work must present research evidence, traceability, replay, artifacts, metrics, ledgers, and gates. It must avoid clinical decision-support claims unless explicit gate evidence exists.

Current presentation artifact: root `index.html` is the active tracked browser UI restored from the last UI commit before `b998af4`. Manuscript figure artifacts and `tools/build-figures.mjs` are intentionally absent from the working tree and recoverable from Git history.

Closeout:
1. Verify changed artifacts with local tools.
2. Keep `.gitignore` aligned with generated outputs.
3. Update `.agent/session-plan.md` and `.agent/memory.md` only with durable, non-obvious state from the session.
4. Commit one scoped change before final response when work is complete.
