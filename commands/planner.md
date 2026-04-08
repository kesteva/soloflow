---
description: Turn an approved idea into execution-ready task plans
argument-hint: <IDEA-NNN>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:planner

Phase 2 of the SoloFlow pipeline. Reads an approved idea (and its research report, if present) and produces execution-ready task plans. Populates the backlog.

The target idea is: **$ARGUMENTS**

---

## Step 0: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Load the Idea

1. Parse `$ARGUMENTS` as an idea ID (e.g., `IDEA-001`). If empty or malformed, list `.soloflow/active/ideas/` and use the **AskUserQuestion** tool to let the user pick which idea to refine — pass the discovered idea IDs as options rather than printing them as prose.
2. Read `.soloflow/active/ideas/IDEA-{NNN}.md`. If missing, report the error and stop.
3. Check for `.soloflow/active/research/IDEA-{NNN}-research.md` — if present, it will be passed to the refiner.
4. Read `.soloflow/counters.json` for the starting task counter: `tasks + 1`.

## Step 2: Refine

1. Spawn the **task-refiner** agent via the Agent tool with:
   - The approved idea file content
   - If a research report exists, include it with: "A research report is provided below. Use it to inform your approach selection, library choices, and to resolve open questions before doing your own research."
   - The starting task counter
   - Instruction: "Refine this idea into execution-ready plans. Start task numbering at TASK-{NNN}. Output each plan file's content clearly separated."
2. Capture the refiner's output.
3. Parse the output into individual plan files.
4. Write each plan to `.soloflow/active/plans/TASK-{NNN}-plan.md`.
5. Update `.soloflow/counters.json`: increment `tasks` by the number of plans.
6. Add each task to `.soloflow/active/backlog.json` with `status: "ready"` and its `depends_on` list.

## Step 3: Human Checkpoint — Plan Review

Present all plans to the user with:
- Task count and dependency graph
- Total estimated complexity
- Decisions made and tradeoffs resolved
- Open questions requiring human input (if any were escalated)
- Any requirements that were dropped with reasoning

Use the **AskUserQuestion** tool to present the choice. Do not list the options as plain markdown bullets — the user should see a structured picker. Ask "How should we proceed with these plans?" with these options:
- **Approve all** — leave all tasks `status: "ready"` in backlog.json
- **Approve subset** — mark unapproved plans as `status: "deferred"` in backlog.json
- **Request changes** — re-run the refiner with the user's feedback
- **Reject** — delete the plan files and remove their backlog entries

The tool call blocks until the user responds — do not proceed until it returns.

## Step 4: Report

```
Planning complete for IDEA-{NNN}.
- Tasks created: {count} (TASK-{NNN}..TASK-{NNN})
- Ready: {count} | Deferred: {count}

Next step: /soloflow:executor
```

---

## Notes

- This command does NOT execute any tasks — that's `/soloflow:executor`.
- Config reference: `executor_retry_max`, `max_sprint_tasks` in `config/defaults.yaml` apply at execution time, not here.
