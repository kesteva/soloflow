---
description: Identify, resolve, and verify a bug. Spawns bug-investigator → executor → shadow-verifier in sequence.
argument-hint: <bug report — symptoms, expected vs actual, optional reproduction steps> [--no-confirm]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:bugfix

You are running the SoloFlow bugfix workflow. The user has reported a bug. Your job is to:

1. **Identify** the bug — spawn the bug-investigator to do read-only root-cause analysis.
2. **Confirm** the hypothesis with the user (unless `--no-confirm` is in `$ARGUMENTS`).
3. **Resolve** the bug — spawn the executor with a precise plan derived from the investigation.
4. **Verify** the fix — spawn shadow-verifier; on `NEEDS_CHANGES`, retry the executor.
5. **Lock it in** — spawn test-writer to add a regression test.

This command is a sibling of `/soloflow:quick`. Both run a single task inline (no run branch, no worktree, no parallelism, no per-task code review). The difference: `/quick` assumes the user already knows the fix; `/bugfix` performs a dedicated investigation step first and gates on user confirmation before any code changes.

The bug report is: **$ARGUMENTS**

Parse `$ARGUMENTS` for the optional `--no-confirm` flag. If present, strip it from the bug report text before passing the rest to the investigator, and skip the confirmation gate in Step 4.

## Step 1: Resolve models + limits (cache for the rest of the run)

Run once at the start, cache the result:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" --all
```

Keys consumed:
- `models.bug_investigator` (fallback: `opus`) — the investigator runs Opus by default for judgment.
- `models.executor` / `models.test_writer` (fallback: `sonnet`)
- `models.verifier` (fallback: `opus`)
- `limits.executor_retry_max` (fallback: 3) — cap on `NEEDS_CHANGES` retries in Step 8.
- `limits.context_limit_respawn_max` (fallback: 3) — cap on `CONTEXT_LIMIT` respawns for any agent.

Reuse the cached values across all agent spawns and respawns. Also cap **investigator re-spawns** (after `INVESTIGATION_INCONCLUSIVE` + new user input in Step 3) at **2** — independent of the context-limit budget.

## Step 2: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 3: Spawn bug-investigator

Use the Agent tool with `subagent_type: "bug-investigator"` and the cached `models.bug_investigator`. Prompt body:

```
Investigate this bug report. Produce a structured root-cause analysis. Do NOT write code.

Bug report:
{user's $ARGUMENTS, with --no-confirm stripped}
```

Wait for the investigator's report and read its verdict.

### Handle investigator verdict

- **ROOT_CAUSE_FOUND** → proceed to Step 4 (confirmation gate).
- **INVESTIGATION_INCONCLUSIVE** → present the report's `Reproduction Blockers` and `Alternatives Considered` to the user. Use **AskUserQuestion** with options:
  - **Provide more context** — accept free-form input, then re-spawn the investigator with the original report + transcript of what was ruled out + the new user input. Cap at 2 re-spawns; on the third inconclusive, escalate as below.
  - **Treat as inconclusive and stop** — exit without writing a plan; report what was learned.

  If the cap is hit, write a one-line entry to `.soloflow/human-review-queue.md` (use the canonical schema from [commands/quick.md](quick.md) Step 7 HUMAN_NEEDED branch, with `type: investigation_inconclusive`, `task: null`, and `bucket: decisions` — investigation outcomes that cannot converge are always judgment calls for the user) and stop. No TASK-NNN is allocated when investigation never converges.
- **NOT_A_BUG** → present the investigator's reasoning to the user and stop. Do not allocate a TASK-NNN. Suggest the user file `/soloflow:idea-extractor` if they actually want a behavior change.
- **CONTEXT_LIMIT** → read the `### Handoff` section. If respawns < `limits.context_limit_respawn_max`, spawn a fresh investigator with the original report + "Continue from previous investigator's handoff: {handoff section}". Otherwise treat as `INVESTIGATION_INCONCLUSIVE` (run the cap-hit branch).

## Step 4: User confirmation gate

Skip this step entirely if `--no-confirm` was in `$ARGUMENTS`. Otherwise, use **AskUserQuestion** to surface the investigator's hypothesis:

Frame the question around the investigator's `Root Cause`, `Affected Files`, `Proposed Fix`, and `Confidence`. Options:

- **Proceed** — accept the hypothesis. Continue to Step 5.
- **Refine** — accept free-form input from the user (additional context, hint to look elsewhere, alternative hypothesis). Re-spawn the investigator (Step 3) with the original report + the previous investigation report + the user's refinement. The 2-respawn cap from Step 3 still applies; count `Refine` rounds against it.
- **Abort** — stop without writing any plan or modifying state.

If the investigator's `Confidence` is `low`, treat the gate as required even if `--no-confirm` was set — the user did not opt into autonomous mode for low-confidence diagnoses. Print a one-line note explaining the override.

## Step 5: Allocate TASK-NNN

Compute the next task ID using the shared recipe (same as [commands/quick.md](quick.md) Step 3):

Glob every TASK file location:
- `.soloflow/active/plans/**/TASK-*-plan.md`
- `.soloflow/active/stuck/**/TASK-*-stuck.md`
- `.soloflow/archive/done/**/TASK-*-done.md`

Extract numeric suffixes and take `max + 1` (zero-padded to 3 digits).

## Step 6: Write the plan file

Write `.soloflow/active/plans/TASK-{NNN}-plan.md` with `noclobber`/`wx` semantics; if it exists (parallel-worker race), recompute the next ID and retry. Format:

```markdown
---
id: TASK-{NNN}
idea: inline
status: ready
created: {ISO timestamp}
files_owned:
  - {paths from investigator's affected_files where role is fault, symptom, or test_target}
files_readonly:
  - {paths from investigator's affected_files where role is context}
acceptance_criteria:
  - criterion: "Reproduction steps no longer trigger the bug"
    verification: "{how — derive from investigator's Reproduction section}"
  - criterion: "Regression test exists and passes"
    verification: "Test at {path from test_target affected_file} runs and passes"
  - {any additional behavioral criteria the investigator surfaced}
depends_on: []
estimated_complexity: low|medium|high
---

# Bugfix: {one-line summary from investigator's Bug Summary}

## Bug Summary

{Copy investigator's Bug Summary verbatim}

## Root Cause

{Copy investigator's Root Cause verbatim}

## Reproduction

{Copy investigator's Reproduction verbatim}

## Implementation Steps

{Derive from investigator's Proposed Fix. Be concrete: each step references a specific file and function. The investigator gave you the prescription; turn it into ordered, imperative steps.}

## Acceptance Criteria

{Restate each criterion from the frontmatter with clear pass/fail definitions.}
```

If the investigator's affected_files list is empty (which should not happen for `ROOT_CAUSE_FOUND` but guard anyway), stop with an error — do not invent files.

## Step 7: Scaffold sprint + findings

Add the task entry to `sprint.json` and create the per-sprint findings file. Use the same recipe as [commands/quick.md](quick.md) Step 3:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/update-task-status.js" TASK-{NNN} in_progress --create --plan .soloflow/active/plans/TASK-{NNN}-plan.md
```

`--create` scaffolds a per-sprint `.soloflow/active/sprints/SPRINT-quick-<timestamp>/sprint.json` (using the `quick` prefix; the `--create` path uses one shared scaffold across `/quick` and `/bugfix`) if no active sprint exists. Future cleanup may distinguish bugfix-created sprints; today they share the prefix.

After `--create` completes, glob `.soloflow/active/sprints/*/sprint.json` to find the active sprint and read `sprint.id`. Call this value `{sprint_id}` for the rest of the command. Ensure `.soloflow/active/findings/` exists. If `.soloflow/active/findings/{sprint_id}-findings.md` does not exist, create it with `wx`/`noclobber` semantics:

```
---
sprint: {sprint_id}
pending_count: 0
last_updated: null
---

# Findings Queue
```

## Step 8: Spawn executor

Use the Agent tool with `subagent_type: "executor"` and the cached `models.executor`. Prompt:

```
Implement this task plan. Follow every step. Report your status when done.

{full content of the plan file}
```

Wait for the executor's status report.

### Handle executor result

- **COMPLETED** → Step 9 (verifier).
- **BLOCKED** → run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} blocked --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings/{sprint_id}-findings.md`. Report the blocker. Stop.
- **STUCK** → write `.soloflow/active/stuck/TASK-{NNN}-stuck.md` with the executor's error details. Run `settle-task.js TASK-{NNN} stuck --stuck-report ... --touched ...`. Report. Stop.
- **CONTEXT_LIMIT** → read `### Handoff`. If respawns < `limits.context_limit_respawn_max`, spawn a fresh executor with the plan + "Continue from previous executor's handoff: {handoff}". Otherwise escalate as STUCK.

## Step 9: Spawn shadow-verifier

Use the Agent tool with `subagent_type: "shadow-verifier"` and the cached `models.verifier`. Prompt:

```
Verify this completed task. The plan and executor report are below. Run all checks independently.

PLAN:
{full plan file content}

EXECUTOR REPORT:
{executor's status report verbatim}
```

The plan's first acceptance criterion ("Reproduction steps no longer trigger the bug") will route the verifier through Level 1 (run tests) and/or Level 2 (visual reproduction) per its standard 5-level hierarchy — no bugfix-specific verification logic is needed.

Wait for the verdict.

### Handle verifier verdict

- **APPROVED** → Step 10.
- **NEEDS_CHANGES** → check the loop counter (starts at 1, capped at `limits.executor_retry_max`):
  - If loops < cap: re-spawn the executor (Step 8) with the verifier's `Changes Required` appended to the prompt: "Previous attempt had issues. The verifier found: {Changes Required block}. Fix these specific issues." Increment the loop counter, then re-verify (back to Step 9).
  - If loops >= cap: write a stuck report including the verifier's feedback. Run `settle-task.js TASK-{NNN} stuck ...`. Report that the fix needs human intervention. Stop.
- **APPROVED_WITH_DEFERRED** → treat as APPROVED for Step 10 and beyond. The deferred items are already in `.soloflow/human-review-queue.md` from the verifier; the final summary should mention them.
- **HUMAN_NEEDED** → append to `.soloflow/human-review-queue.md` using the canonical schema from [commands/quick.md](quick.md) Step 7 HUMAN_NEEDED branch (with `task: TASK-{NNN}`, `type: HUMAN_NEEDED`, `plan_ref`, `verdict_notes`, `action`, `severity`). Run `settle-task.js TASK-{NNN} human_needed ...`. Report. Stop.
- **CONTEXT_LIMIT** → respawn fresh verifier with handoff (cap at `limits.context_limit_respawn_max`). On exhaustion, log to human-review-queue and stop.

## Step 10: Spawn test-writer

Use the Agent tool with `subagent_type: "test-writer"` and the cached `models.test_writer`. Prompt:

```
Add a regression test for this bug so it cannot recur. The plan, executor changes, and verifier report are below. No code-review report (bugfix path skips per-task code review).

PLAN:
{full plan file content}

EXECUTOR CHANGES:
{from executor report — files modified and commits}

VERIFIER REPORT:
{verifier report verbatim}
```

If the executor or investigator already wrote a regression test (e.g., the reproduction in the plan was a unit test), test-writer will recognize that and confirm rather than duplicate.

Handle test-writer outcomes per the standard pattern (TESTS_WRITTEN → run suite, one retry on failure, then log a finding and proceed; NO_TESTS_NEEDED / NO_TEST_INFRA → proceed; CONTEXT_LIMIT → respawn).

## Step 11: Write done report and settle

Write `.soloflow/archive/done/TASK-{NNN}-done.md` with frontmatter (using the schema referenced in [commands/quick.md](quick.md) Step 7 APPROVED branch):

```yaml
---
id: TASK-{NNN}
status: done
summary: "{one-line summary of the fix}"
executor_loops: {your loop counter — 1 if approved first try}
code_review_rounds: 0   # bugfix path skips per-task code review, same as /quick
visual_mobile: {verbatim from verifier's Visual Verification report}
visual_web: {verbatim from verifier's Visual Verification report}
investigation_confidence: {verbatim from investigator's Confidence}
---
```

The `investigation_confidence` field is bugfix-specific — it lets the compounder later notice patterns like "low-confidence investigations correlate with NEEDS_CHANGES retries." Other done-report consumers ignore unrecognized fields, so adding it here does not break anything.

Then run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} done --done-report .soloflow/archive/done/TASK-{NNN}-done.md --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings/{sprint_id}-findings.md
```

This removes the task from `sprint.json` and commits `chore(TASK-{NNN}): done`.

## Step 12: Final summary

Report to the user:

```
## SoloFlow Bugfix — Summary
- **Task:** TASK-{NNN}
- **Verdict:** {APPROVED | STUCK | HUMAN_NEEDED}
- **Root cause:** {one-line from investigator's Root Cause}
- **Investigation confidence:** {high | medium | low}
- **Executor loops:** {count}
- **Files changed:** {list from executor report}
- **Regression test:** {path written by test-writer, or "already existed: {path}"}
- **Commits:** {list}
```

If any deferred or human-review items were queued during the run, list them under a "Human review needed" section pointing at `.soloflow/human-review-queue.md`.

## Important Notes

- **Do not skip the investigator.** If the user already knows the fix and wants to skip investigation, they should use `/soloflow:quick` instead. The investigator is the whole point of `/bugfix`.
- **Per-task code review is intentionally skipped**, same as `/quick`. If a bugfix surfaces broader concerns, the verifier flags them as findings; the compounder picks them up. For deeper review, the user can run `/soloflow:sprint` against backlog tasks where code review is on by default.
- **No worktree.** This command runs inline on the current branch. Parallelism is unnecessary for single-task bugfixes.
- **`--no-confirm` is for autonomous use** (e.g., scripted bug triage on a CI worker). Always print the investigator's hypothesis before proceeding so the user can read it after the fact, and override `--no-confirm` when confidence is `low` (see Step 4).

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
