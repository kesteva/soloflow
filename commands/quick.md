---
description: Lightweight bugfix path — skip refinement, go straight to executor + verifier
argument-hint: <description of the bug or fix>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:quick

You are running the SoloFlow quick bugfix workflow. The user has described a bug or small fix. Your job is to create an inline plan, execute it, and verify the result.

The bug description is: **$ARGUMENTS**

## Model resolution (applies to every Agent spawn below)

Before invoking the Agent tool for any subagent, resolve `models.<name>` per the
three-tier recipe in [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
(`.soloflow/config.json` → `$CLAUDE_PLUGIN_ROOT/config/defaults.yaml` → inline
fallback). Pass the resolved value as the Agent tool's `model` parameter.

Mapping used in this command:
- `executor` → `models.executor` (fallback: `sonnet`)
- `verifier` → `models.verifier` (fallback: `opus`)
- `test-writer` → `models.test_writer` (fallback: `sonnet`)

Cache the resolved values at the start of the run and reuse them for respawns.

## Limits resolution (applies throughout this command)

Resolve these limits per the recipe in
[docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md) at run
start, then use the resolved values wherever the corresponding concept appears
below:

- `limits.executor_retry_max` (fallback: 3) — cap on `NEEDS_CHANGES` retries in Step 7
- `limits.context_limit_respawn_max` (fallback: 3) — cap on `CONTEXT_LIMIT` respawns

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

Write the plan file with `noclobber`/`wx` semantics; if it already exists (a parallel worker raced), recompute the next ID and retry. Then add the task entry to `.soloflow/active/sprint.json` (quick path skips backlog) by running:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/update-task-status.js" TASK-{NNN} in_progress --create --plan .soloflow/active/plans/TASK-{NNN}-plan.md
```

`--create` scaffolds `sprint.json` (with a `SPRINT-quick-<timestamp>` id) if it doesn't exist yet, and inserts the task entry.

## Step 4: Spawn Executor

Use the Agent tool to spawn the **executor** agent:
- Pass the full content of the plan file as the prompt
- Prefix the plan with: "Implement this task plan. Follow every step. Report your status when done."
- Set `subagent_type` to use the executor agent

Wait for the executor to complete and capture its status report.

## Step 5: Handle Executor Result

Read the executor's status report:

- **If COMPLETED**: Proceed to Step 6 (verification).
- **If BLOCKED**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} blocked --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings.md`. Report the blocker to the user. Stop here.
- **If STUCK**: Write a stuck report to `.soloflow/active/stuck/TASK-{NNN}-stuck.md` with the executor's error details. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report .soloflow/active/stuck/TASK-{NNN}-stuck.md --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings.md`. Report to the user. Stop here.
- **If CONTEXT_LIMIT**: Read the `### Handoff` section. If context-limit respawns < resolved `limits.context_limit_respawn_max`, spawn a **fresh executor** with the original plan + "Continue from previous executor's handoff: {handoff section}". Otherwise escalate as STUCK.

## Step 6: Spawn Verifier

Use the Agent tool to spawn the **verifier** agent:
- Pass BOTH the plan file content AND the executor's status report
- Prefix with: "Verify this completed task. The plan and executor report are below. Run all checks independently."
- Set `subagent_type` to use the verifier agent

Wait for the verifier's verdict.

## Step 7: Handle Verifier Verdict

Read the verifier's verification report:

### If APPROVED
1. Spawn **test-writer** with the plan, executor's changed files, and "no code-review report" (quick path skips code review). If `TESTS_WRITTEN`, run the test suite to confirm. One retry on failure; if still failing, log a finding and proceed.
2. Write a done report to `.soloflow/archive/done/TASK-{NNN}-done.md` using the verifier's report. Use the frontmatter spec defined in `commands/executor.md` step f3 — populate `executor_loops` from your loop counter, set `code_review_rounds: 0` (quick path skips code review), and copy `visual_mobile` / `visual_web` verbatim from the verifier's Visual Verification report block.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} done --done-report .soloflow/archive/done/TASK-{NNN}-done.md --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings.md`. This removes the task from `sprint.json` and commits `chore(TASK-{NNN}): done`.
4. Report success to the user with a summary of changes.

### If NEEDS_CHANGES
Check the loop counter (starts at 1, capped at resolved `limits.executor_retry_max`):
- **If loops < resolved cap**: Go back to Step 4, but append the verifier's feedback to the executor prompt:
  "Previous attempt had issues. The verifier found: {verifier feedback}. Fix these specific issues."
  Increment the loop counter.
- **If loops >= resolved cap**: The task is stuck. Write a stuck report to `.soloflow/active/stuck/TASK-{NNN}-stuck.md` including the verifier's feedback, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report .soloflow/active/stuck/TASK-{NNN}-stuck.md --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings.md`. Report to the user that the fix needs human intervention.

### If HUMAN_NEEDED
1. Append an entry to `.soloflow/human-review-queue.md` with the verifier's notes.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} human_needed --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings.md`.
3. Report to the user that the fix works technically but needs their review for product judgment.

## Step 7.5: State commit

State commit happens inside `settle-task.js` (invoked by each verdict branch in Step 7). The quick command does not run `git add` / `git commit` itself for task state.

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
- Keep the plan focused. This is the quick path — one bug, one fix. If the bug turns out to be bigger than expected, tell the user to use `/soloflow:idea-extractor` → `/soloflow:planner` → `/soloflow:sprint` instead.

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
