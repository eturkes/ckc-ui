# Reusable Session Prompt

Preferred invocation:
`$session-prompt <TASK>`

You are working in `/run/host/home/eturkes/Projects/scratch/ckc-ui`.

Load order:
1. `AGENTS.md`
2. `SPEC.md` sections needed for the requested unit
3. `.agent/memory.md` if it exists

Standing project intent: CKC is a headless clinical knowledge compiler. UI work must present research evidence, traceability, replay, artifacts, metrics, ledgers, and gates. It must avoid clinical decision-support claims unless explicit gate evidence exists.

Current UI seed artifact: `mockups/ckc-spec04-start.html` is a compact standalone workbench mockup covering SPEC.md §0-§15 under the spec04 M1-M6 framing. Treat it as exploratory design material, not implementation authority or measured output.

Default closeout:
1. Verify changed artifacts with local tools.
2. Keep `.gitignore` aligned with generated outputs.
3. Commit one scoped change before final response when work is complete.

Requested task:
<TASK>

When `<TASK>` is empty, ask for the missing task before changing files.
