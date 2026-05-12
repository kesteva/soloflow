---
description: Quickly capture multiple ideas and tasks from a braindump session
argument-hint: "- idea one\n- idea two\n- fix the login bug"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:braindump

Rapid batch-capture tool. Turns a stream of bullet-point ideas into IDEA and TASK files via heuristic classification (no agents — speed is the point), then offers to refine the new IDEAs in parallel.

This command is a **preconfigured wrapper** for `/soloflow:planner`. The unified planner is the canonical entry; this wrapper exists for users who want the focused multi-item batch flow without seeing the open prompt.

The user's input is: **$ARGUMENTS**

---

## Step 1: Dispatch into the unified planner

Read `${CLAUDE_PLUGIN_ROOT}/commands/planner.md` with the `Read` tool and execute its procedure end-to-end with `$ARGUMENTS` rebound to:

```
--mode=multi-idea $ARGUMENTS
```

That is, prepend the literal token `--mode=multi-idea` followed by a single space, then the original `$ARGUMENTS`. The planner's Step 0.5 (Mode resolution) detects the token, strips it, and routes directly into Phase 1b (multi-idea heuristic capture). If `$ARGUMENTS` is empty, Phase 1b runs in its interactive mode (Step 1b.1 sub-mode B) and collects items via repeated `AskUserQuestion`.

Phase 1b behaves identically to this command's historical surface: parse a bullet list, classify each item as IDEA or TASK via heuristics, present a summary table with reclassify/edit/cancel/approve options, batch-create files, commit, then prompt to refine the new IDEAs (`Refine all` / `Refine some` / `Not yet`). On `Refine all` or `Refine some`, the planner falls through to Phase 2 — using the multi-IDEA parallel path when more than one IDEA is to be refined and `parallelism.task_refiner_parallel` resolves true.

Do NOT re-run any of the planner's earlier steps independently — treat the planner's instructions as a continuation of this run.

---

## Notes

- For a single in-depth idea (clarify + extract + research), use `/soloflow:idea-extractor` (also a thin wrapper).
- For refining an existing IDEA, use `/soloflow:planner IDEA-NNN` directly.
- The unified `/soloflow:planner` (with no args) opens with a mode picker; it's the canonical entry when you're not sure which path you need.
