---
description: Lightweight bugfix path — skip refinement, go straight to executor + verifier
argument-hint: <description of the bug or fix>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:quick

You are running the SoloFlow quick bugfix workflow. The user has described a bug or small fix. Your job is to create an inline plan, execute it, and verify the result.

The bug description is: **$ARGUMENTS**

## Step 1: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 2: Ground the Bug

Search the codebase to understand the bug:
1. Use Grep and Glob to find files related to the bug description
2. Read the relevant files to understand the current behavior
3. Identify which files need to change and which are context-only

This step is critical — the plan you create must reference real files and real code.

## Step 3: Create the Plan

Compute the next task ID by globbing every TASK file location (`.soloflow/active/plans/**/TASK-*-plan.md`, `.soloflow/active/stuck/**/TASK-*-stuck.md`, `.soloflow/archive/done/**/TASK-*-done.md`), extracting numeric suffixes, and taking `max + 1` (zero-padded to 3 digits). See the "ID allocation" section in the project `CLAUDE.md` for the shared recipe.

Write a plan file to `.soloflow/active/plans/TASK-{NNN}-plan.md` with this exact format:

```markdown
---
id: TASK-{NNN}
idea: inline
status: approved
created: {ISO timestamp}
files_owned:
  - {files that need to change}
files_readonly:
  - {files for context only}
acceptance_criteria:
  - criterion: "{what must be true}"
    verification: "{how to verify it}"
depends_on: []
estimated_complexity: low|medium|high
---

# {Bug/Fix Title}

## Objective

{One sentence: what this fixes and why}

## Implementation Steps

1. {Concrete step referencing specific files and functions}
2. {Next step}

## Acceptance Criteria

{Restate each criterion with clear pass/fail definition}
```

Write the plan file with `noclobber`/`wx` semantics; if it already exists (a parallel worker raced), recompute the next ID and retry. Then:
- Add the task entry with `status: "in_progress"` to `.soloflow/active/sprint.json` (quick path skips backlog)

## Step 4: Spawn Executor

Use the Agent tool to spawn the **executor** agent:
- Pass the full content of the plan file as the prompt
- Prefix the plan with: "Implement this task plan. Follow every step. Report your status when done."
- Set `subagent_type` to use the executor agent

Wait for the executor to complete and capture its status report.

## Step 5: Handle Executor Result

Read the executor's status report:

- **If COMPLETED**: Proceed to Step 6 (verification).
- **If BLOCKED**: Update the task in `.soloflow/active/sprint.json` to `status: "blocked"`. Report the blocker to the user. Stop here.
- **If STUCK**: Write a stuck report to `.soloflow/active/stuck/TASK-{NNN}-stuck.md` with the executor's error details. Update `.soloflow/active/sprint.json` to `status: "stuck"`. Report to the user. Stop here.

## Step 6: Spawn Verifier

Use the Agent tool to spawn the **verifier** agent:
- Pass BOTH the plan file content AND the executor's status report
- Prefix with: "Verify this completed task. The plan and executor report are below. Run all checks independently."
- Set `subagent_type` to use the verifier agent

Wait for the verifier's verdict.

## Step 7: Handle Verifier Verdict

Read the verifier's verification report:

### If APPROVED
1. Write a done report to `.soloflow/archive/done/TASK-{NNN}-done.md` using the verifier's report
2. Remove the task from `.soloflow/active/sprint.json`
3. Report success to the user with a summary of changes

### If NEEDS_CHANGES
Check the loop counter (starts at 1, max 3 from config `executor_retry_max`):
- **If loops < 3**: Go back to Step 4, but append the verifier's feedback to the executor prompt:
  "Previous attempt had issues. The verifier found: {verifier feedback}. Fix these specific issues."
  Increment the loop counter.
- **If loops >= 3**: The task is stuck. Write a stuck report to `.soloflow/active/stuck/TASK-{NNN}-stuck.md` including the verifier's feedback. Update `.soloflow/active/sprint.json` to `status: "stuck"`. Report to the user that the fix needs human intervention.

### If HUMAN_NEEDED
1. Add an entry to `.soloflow/human-review-queue.md` with the verifier's notes
2. Update `.soloflow/active/sprint.json` to `status: "human_needed"`
3. Report to the user that the fix works technically but needs their review for product judgment

## Step 8: Final Summary

Report to the user:
```
## SoloFlow Quick — Summary
- **Task:** TASK-{NNN}
- **Verdict:** {APPROVED | STUCK | HUMAN_NEEDED}
- **Executor loops:** {count}
- **Files changed:** {list}
- **Commits:** {list}
```

## Important Notes

- The executor uses model `sonnet` for cost efficiency. The verifier uses model `opus` for thorough analysis.
- Each executor run should produce atomic commits — do not squash them.
- If the user's bug description is too vague to create a concrete plan, ask the user for clarification BEFORE creating the plan. Do not guess. Prefer the **AskUserQuestion** tool when the clarification can be framed as a choice between candidate interpretations; use a free-form text question only when the clarification is genuinely open-ended.
- Keep the plan focused. This is the quick path — one bug, one fix. If the bug turns out to be bigger than expected, tell the user to use `/soloflow:idea-extractor` → `/soloflow:planner` → `/soloflow:executor` instead.
