---
description: Run an execution sprint over ready tasks in the backlog
argument-hint: [optional: TASK-NNN TASK-NNN ... or idea ID to filter]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:executor

Phase 3 of the SoloFlow pipeline. Creates a sprint from ready tasks in the backlog and runs the executor → verifier → code-reviewer loop until the sprint is complete.

Arguments: **$ARGUMENTS** (optional — specific task IDs to include, or an `IDEA-NNN` to filter; if empty, include all ready tasks up to `max_sprint_tasks`)

---

## Step 1: Initialize

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:idea-extractor` first." and stop.
2. Read `.soloflow/checkpoint.md` — if it indicates an active sprint mid-execution, use the **AskUserQuestion** tool (question: "Sprint {SPRINT-NNN} is in progress. Resume it or start fresh?", options: **Resume** / **Start fresh**). Do not print the choice as prose.
   - If resume: load `sprint.json` and continue the execution loop below.
   - If fresh: archive the stale sprint and continue.
3. Read `.soloflow/active/backlog.json`.

## Step 2: Create Sprint

1. Select tasks:
   - If `$ARGUMENTS` names specific task IDs, include only those.
   - If `$ARGUMENTS` names an idea (`IDEA-NNN`), include all ready tasks belonging to that idea.
   - Otherwise, include all `status: "ready"` tasks up to `max_sprint_tasks` (config default: 10).
2. If no tasks match, tell the user: "No ready tasks in backlog. Run `/soloflow:planner IDEA-NNN` first." and stop.
3. Read `.soloflow/counters.json` for sprint counter.
4. Generate sprint ID: `SPRINT-{padded sprints + 1}`.
5. Create `.soloflow/active/sprint.json` with:
   - `sprint.status: "active"`, `sprint.started: {ISO timestamp}`
   - Selected tasks moved from `backlog.json` into `sprint.json`
6. Increment `sprints` in `.soloflow/counters.json`.

## Step 3: Execute the Loop

1. **Build dependency graph** from tasks' `depends_on` fields. Tasks with no dependencies are immediately ready.

2. For each ready task (dependencies all completed):

   a. Set task `status: "in_progress"` in `sprint.json`.

   b. Spawn **executor** agent with the plan content. Wait for result.

   c. Handle executor result:
      - **COMPLETED** → proceed to verification.
      - **BLOCKED** → update status to `"blocked"` in `sprint.json`, continue to next task.
      - **STUCK** → write stuck report to `.soloflow/active/stuck/TASK-{NNN}-stuck.md`, update status in `sprint.json`, continue.

   d. Spawn **verifier** with plan + executor report. Wait for verdict.

   e. Handle verifier verdict:
      - **APPROVED** → proceed to code review (step f).
      - **NEEDS_CHANGES** → if loops < `executor_retry_max` (config default: 3), re-spawn executor with verifier feedback. Otherwise write stuck report.
      - **HUMAN_NEEDED** → add to `.soloflow/human-review-queue.md`, update status in `sprint.json`.

   f. Spawn **code-reviewer** with the plan + executor's changed files list. Wait for verdict.
      - **CLEAN** → write done report to `.soloflow/archive/done/TASK-{NNN}-done.md`, remove task from `sprint.json`.
      - **IMPROVEMENTS_NEEDED** (first time only) → re-spawn executor with review feedback, then re-verify. Does NOT consume the executor retry budget.
      - **SECURITY_ISSUE** → escalate to HUMAN_NEEDED. Add to `.soloflow/human-review-queue.md`, update status in `sprint.json`.

   g. Every `checkpoint_interval` completed tasks (config default: 3), write checkpoint to `.soloflow/checkpoint.md`.

3. **Complete sprint** — set `sprint.status: "complete"` in `sprint.json`.

## Step 4: Human Review

Read `.soloflow/human-review-queue.md` and all stuck reports from `.soloflow/active/stuck/`.

Present a consolidated review:
- **Completed tasks** with brief summaries
- **Tasks needing human judgment** (HUMAN_NEEDED verdicts) with verifier notes
- **Stuck tasks** with failure details and what was tried
- **Sprint statistics:** completed, stuck, human-needed, total executor loops

**PAUSE HERE.** The user's job is taste-level review — everything functional has already been verified.

## Step 5: Report

```
Sprint SPRINT-{NNN} complete.
- Completed: {count}
- Stuck: {count}
- Human-needed: {count}
- Total executor loops: {count}

Next step: /soloflow:compound  (to extract learnings from this sprint)
```

---

## Checkpoint Format

Write to `.soloflow/checkpoint.md` with YAML frontmatter + human-readable body:

```markdown
---
last_updated: {ISO timestamp}
active_sprint: SPRINT-{NNN}
phase: 3
tasks_completed: [TASK-NNN, ...]
tasks_in_flight: [TASK-NNN, ...]
tasks_stuck: [TASK-NNN, ...]
tasks_human_needed: [TASK-NNN, ...]
next_action: "{what to do next}"
---

# Session Checkpoint

{Human-readable summary of sprint state}
```

---

## Notes

- This command IS the orchestrator for Phase 3. It runs in the main session and spawns executor/verifier/code-reviewer as leaf-node subagents.
- Config: `executor_retry_max`, `checkpoint_interval`, `max_sprint_tasks` in `config/defaults.yaml`.
