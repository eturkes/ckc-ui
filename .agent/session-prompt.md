# Reusable Session Prompt

Preferred invocation:
`$session-prompt [TASK]`

You are working in `/run/host/home/eturkes/Projects/scratch/ckc-ui`.

Load order:
1. `AGENTS.md`
2. `SPEC.md` sections needed for the requested task
3. `.agent/memory.md` if it exists

Task selection:
- If `<TASK>` is non-empty, use it as the requested task.
- If `<TASK>` is empty, report that an explicit task is required before changing
  files.

Standing project intent: CKC is a headless clinical knowledge compiler. Presentation work must present research evidence, traceability, replay, artifacts, metrics, ledgers, and gates. It must avoid clinical decision-support claims unless explicit gate evidence exists.

Current presentation artifact: root `index.html` is the active tracked browser UI restored from the last UI commit before `b998af4`. Manuscript figure artifacts and `tools/build-figures.mjs` are intentionally absent from the working tree and recoverable from Git history.

Active multi-session plan: `.agent/session-plan.md` contains the comparison
expansion queue as historical completion evidence only. No-argument
`$session-prompt` invocations require a new explicit task.

Closeout:
1. Verify changed artifacts with local tools.
2. Keep `.gitignore` aligned with generated outputs.
3. Update `.agent/session-plan.md` and `.agent/memory.md` only with durable,
   non-obvious state from the session.
4. Commit one scoped change before final response when work is complete.
