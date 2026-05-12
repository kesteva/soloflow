---
description: Extract a structured idea from raw input, with optional external research
argument-hint: <idea or feature description>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:idea-extractor

Phase 1 of the SoloFlow pipeline. Turns raw input into a structured idea file (with codebase grounding and optional external research) and offers to refine it into execution-ready plans.

This command is a **preconfigured wrapper** for `/soloflow:planner`. The unified planner is the canonical entry; this wrapper exists for users who want the focused single-idea flow without seeing the open prompt.

The user's input is: **$ARGUMENTS**

---

## Step 1: Dispatch into the unified planner

Read `${CLAUDE_PLUGIN_ROOT}/commands/planner.md` with the `Read` tool and execute its procedure end-to-end with `$ARGUMENTS` rebound to:

```
--mode=single-idea $ARGUMENTS
```

That is, prepend the literal token `--mode=single-idea` followed by a single space, then the original `$ARGUMENTS`. The planner's Step 0.5 (Mode resolution) detects the token, strips it, and routes directly into Phase 1a (single-idea extract). Phase 1a behaves identically to this command's historical surface: clarify if ambiguous, extract via the idea-extractor agent, optional research, human checkpoint, commit, then prompt to refine into tasks. On `Refine now` the planner falls through to Phase 2; on `Not yet` it stops with a deferred-commands hint.

Do NOT re-run any of the planner's earlier steps independently — treat the planner's instructions as a continuation of this run.

---

## Notes

- For multi-item capture, use `/soloflow:braindump` (also a thin wrapper).
- For refining an existing IDEA, use `/soloflow:planner IDEA-NNN` directly — no need to go through this wrapper.
- The unified `/soloflow:planner` (with no args) opens with a mode picker; it's the canonical entry when you're not sure which path you need.
