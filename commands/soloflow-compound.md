---
description: Extract reusable patterns and learnings from a completed sprint
argument-hint: [optional: SPRINT-NNN]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent]
---

# /soloflow-compound

Phase 5 of the SoloFlow pipeline. Reads done reports and stuck reports from a completed sprint and extracts reusable solutions, decisions, and anti-patterns.

Target sprint: **$ARGUMENTS** (optional — defaults to the most recently completed sprint)

---

## Step 1: Identify the Sprint

1. If `$ARGUMENTS` names a sprint (`SPRINT-NNN`), use it.
2. Otherwise, read `.soloflow/active/sprint.json`. If `sprint.status == "complete"`, use it. Otherwise find the most recently completed sprint from archive.
3. Collect all relevant reports:
   - Done reports from `.soloflow/archive/done/` belonging to this sprint
   - Stuck reports from `.soloflow/active/stuck/` belonging to this sprint
4. If no reports are found, tell the user: "No completed tasks to learn from. Run `/soloflow-executor` first." and stop.

## Step 2: Extract Learnings

1. Read `.soloflow/counters.json` for the starting solution counter: `solutions + 1`.
2. Spawn the **soloflow-compounder** agent via the Agent tool with:
   - Paths and contents of all done reports and stuck reports for this sprint
   - The starting solution counter
   - Instruction: "Extract reusable patterns from this sprint. Write SOL files to `.soloflow/archive/solutions/`. Categorize each as solution, decision, anti-pattern, or process."
3. The compounder writes solution files directly.
4. Update `.soloflow/counters.json`: increment `solutions` by the number of solutions produced.

## Step 3: Report

```
Learning complete for SPRINT-{NNN}.
- Solutions captured: {count}
- Categories: {solutions: N, decisions: N, anti-patterns: N, process: N}

Files written:
  .soloflow/archive/solutions/SOL-{NNN}.md
  ...
```

---

## Notes

- This command does NOT modify any code or task state — it is purely extractive.
- Compounded knowledge is read by future `/soloflow-planner` runs to inform approach selection.
