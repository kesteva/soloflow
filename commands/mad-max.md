---
description: Unattended backlog-drain mode — runs executor → verifier → code-reviewer loops on all ready tasks, logs stuck/human-needed, never prompts
argument-hint: [optional: TASK-NNN TASK-NNN ... or IDEA-NNN to filter]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:mad-max

Unattended variant of `/soloflow:executor`. Drains every ready task in the backlog through the full per-task quality loop (executor → verifier → code-reviewer → test-writer), runs the end-of-sprint regression check, and leaves the run branch open for human review. **No interactive prompts during the run.**

Use this when you want to start a run and walk away. Use `/soloflow:executor` when you want to review scope, deferred items, and merge choice interactively.

Arguments: **$ARGUMENTS** (optional — specific task IDs to include, or an `IDEA-NNN` to filter; if empty, include **all** ready tasks — this is drain mode, not a capped sprint).

---

## Step 0.5: Hard-stop guardrails

Run these three checks in the orchestrator before spawning anything. Any failure prints a single-line reason and stops — mad-max never prompts.

1. **Not initialized.** If `.soloflow/` does not exist, print: `mad-max: SoloFlow not initialized. Run /soloflow:init first.` and stop.

2. **Active sprint.** Read `.soloflow/checkpoint.md` (if present) and `.soloflow/active/sprint.json`. If either indicates an active sprint (checkpoint says mid-execution, or `sprint.json` has `sprint.status: "active"`), print: `mad-max: active sprint {SPRINT-NNN} detected. Run /soloflow:executor to resume or close it first.` and stop.

3. **Dirty worktree.** Run `git status --porcelain`. If non-empty, print: `mad-max: working tree dirty. Commit or stash before starting an unattended run.` and stop.

---

## Step 1: Sprint-initiator — phase 1 (gather)

Spawn the **sprint-initiator** agent with:
```
Phase: gather
```

Parse the structured output. Handle:
- If `status: ERROR` → print the error and stop.
- If `initialized: false` → print "mad-max: SoloFlow not initialized. Run /soloflow:init first." and stop. (Redundant with Step 0.5; keep for safety.)
- If `backlog.ready_count == 0` → print `mad-max: no ready tasks in backlog. Run /soloflow:planner IDEA-NNN first.` and stop.
- If `deferred_items.blocking` is non-empty → print `mad-max: {N} blocking deferred item(s) from prior sprints require human resolution. Run /soloflow:executor instead.` (list the task IDs from each blocking entry) and stop.

If `deferred_items.advisory_count > 0`, print `mad-max: {N} advisory deferred item(s) from prior sprints (non-blocking, continuing).` and proceed.

The gathered payload contains: ready tasks (with epic info), resolved `branch_per_run` config, worktree status, parsed deferred items, next sprint ID, and smoke eligibility.

---

## Step 1.5: Build hardcoded decisions

No `AskUserQuestion` calls. Construct the phase 2 decisions payload:

- `create_branch: true` — always create a run branch so `main` stays clean.
- `remember_branch_choice: false` — mad-max is per-run; never writes to user config.
- `overrides: []` — blocking items already forced an exit in Step 1.
- `selected_task_ids`:
  - If `$ARGUMENTS` names one or more `TASK-NNN` IDs → use those exactly.
  - Else if `$ARGUMENTS` names a single `IDEA-NNN` → include every ready task whose plan has `idea: IDEA-NNN` in its frontmatter.
  - Else → include **every** ready task from the gathered payload (no `max_sprint_tasks` cap).
  - If after filtering the list is empty, print `mad-max: no ready tasks matched filter "$ARGUMENTS".` and stop.
- `sprint_id`: gathered `sprint_id_next`.
- `skip_smoke`: pass gathered `skip_smoke` through unchanged.

---

## Step 2: Sprint-initiator — phase 2 (execute)

Spawn the **sprint-initiator** agent with:
```
Phase: execute
Decisions:
  create_branch: true
  selected_task_ids: [TASK-NNN, ...]
  sprint_id: "{gathered sprint_id_next}"
  overrides: []
  remember_branch_choice: false
  skip_smoke: {gathered skip_smoke value}
```

Parse the structured output. Handle:
- If `status: ERROR` → print the error and stop.
- On success, print: `mad-max: started {sprint_id} on run branch {run.branch} (base: {run.base_branch}@{run.base_sha short}) — {N} tasks queued.`

### Smoke baseline guardrail

If the phase 2 output includes `smoke_results` (non-null) AND the results show test failures or type-check failures, **abort**. Print:
```
mad-max: pre-sprint smoke baseline is red (tests: {failed} failed, type-check: {passed|failed}). Refusing to start an unattended run on a broken baseline. Run /soloflow:executor (which will prompt you) or fix the baseline first.
```
Do not roll back the run branch — leave it for the user to investigate. Stop.

If `smoke_results` is null or all checks passed, proceed.

---

## Step 3: Execute the per-task loop

Mirror `commands/executor.md` Step 3 exactly. The **only** behavioral delta for mad-max:

- **No new early stops.** All terminal statuses (`STUCK`, `HUMAN_NEEDED`, `BLOCKED`) write their report / queue entry / `sprint.json` update and continue to the next ready task.
- **No interactive checkpoint surfacing.** Checkpoints still get written every `checkpoint_interval` completed tasks (Step 3.g) for crash recovery, but mad-max never prompts about them during the run.

Concretely, for each ready task (dependencies satisfied):

a. Set task `status: "in_progress"` in `sprint.json`.

a2. **Locate the plan file** via `.soloflow/active/plans/**/TASK-{NNN}-plan.md` (matches nested epic folders and flat orphan paths; excludes `EPIC-*.md`). Read the plan's `epic` frontmatter field — this determines where downstream reports go.

b. Spawn **executor** agent with the plan content. Wait for result.

c. Handle executor result:
  - **COMPLETED** → proceed to verification.
  - **BLOCKED** → update status to `"blocked"` in `sprint.json`, commit state (step h), continue to next task.
  - **STUCK** → write stuck report to `.soloflow/active/stuck/{epic}/TASK-{NNN}-stuck.md` (or flat if no epic). Update status in `sprint.json`, commit state, continue.
  - **CONTEXT_LIMIT** → pass handoff to a fresh executor (up to `context_limit_respawn_max`, default 3). If exhausted, treat as STUCK. Same protocol as `commands/executor.md:135-141`.

d. Spawn **verifier** with plan + executor report. Wait for verdict.

e. Handle verifier verdict:
  - **APPROVED** / **APPROVED_WITH_DEFERRED** → proceed to code review (step f). Deferred checks already queued in `human-review-queue.md` by the verifier.
  - **NEEDS_CHANGES** → if loops < `executor_retry_max` (default 3), re-spawn executor with verifier feedback. Otherwise write stuck report, commit state, continue to next task.
  - **HUMAN_NEEDED** → add to `.soloflow/human-review-queue.md`, update status in `sprint.json`, commit state, continue.
  - **CONTEXT_LIMIT** → respawn with handoff (same budget).

f. Spawn **code-reviewer** with the plan + executor's changed files list. Wait for verdict.
  - **CLEAN** → proceed to step f2.
  - **IMPROVEMENTS_NEEDED** (first time only) → re-spawn executor with review feedback, then re-verify. Does not consume executor retry budget.
  - **SECURITY_ISSUE** → add to `.soloflow/human-review-queue.md`, update status in `sprint.json`, commit state, continue.
  - **CONTEXT_LIMIT** → respawn with handoff.

f2. **Test writing.** Spawn the **test-writer** agent with the plan, executor's changed files, and code-reviewer's report. Wait for result.
  - **TESTS_WRITTEN** → run the project's test suite via Bash. If the new tests pass, proceed. If they fail, re-spawn test-writer with failure output (one retry). If still failing, log a finding to `.soloflow/active/findings.md` and proceed.
  - **NO_TESTS_NEEDED** / **NO_TEST_INFRA** → proceed.
  - **CONTEXT_LIMIT** → respawn with handoff.

f3. Write done report to `.soloflow/archive/done/{epic}/TASK-{NNN}-done.md` (or flat). Remove task from `sprint.json`. Run the epic archival check: if the plan had an epic and no TASK-*.md files remain under `.soloflow/active/plans/{epic}/` and no sprint tasks from that epic remain, **log to `.soloflow/active/findings.md`** — `epic {epic} has no remaining tasks; candidate for archival` — and do NOT prompt. Archival waits for human review.

g. Every `checkpoint_interval` completed tasks (default 3), write checkpoint to `.soloflow/checkpoint.md`.

h. **Commit state for this task.** After the task settles (done, stuck, blocked, or human-needed), commit `.soloflow/` state changes via Bash:
  - `git add` only the specific state paths touched: `.soloflow/active/sprint.json`, the new done/stuck report path, `.soloflow/active/findings.md` if appended, `.soloflow/human-review-queue.md` if updated, `.soloflow/checkpoint.md` if Step 3.g wrote one.
  - Never `git add .` / `git add -A`.
  - If `git diff --cached --quiet` reports no staged changes, skip.
  - Otherwise commit with a verdict-scoped message: `chore(TASK-{NNN}): done` / `chore(TASK-{NNN}): stuck` / `chore(TASK-{NNN}): blocked` / `chore(TASK-{NNN}): human-needed`.
  - Skip silently if not in a git repo or `.soloflow/` is gitignored.

**End of loop.** Sprint status remains `"active"` until the closer's finalize phase flips it.

---

## Step 3.5: End-of-sprint verification

Spawn the **sprint-verifier** agent with: sprint ID, base SHA (from `sprint.json`'s `run.base_sha`), the list of completed tasks with their plans and changed files, and the resolved visual verification config. Wait for its report.

Handle the report:
- Append any regressions (visual or integration) to `.soloflow/human-review-queue.md` with the failure details, evidence, and suspected responsible task.
- Commit any `.soloflow/` state changes with `chore(SPRINT-{NNN}): end-of-sprint verification`.

Capture `regressions_count` for the final summary.

---

## Step 3.7: Sprint-closer — phase 1 (gather)

Spawn the **sprint-closer** agent with:
```
Phase: gather
```

Wait for its `GATHERED` payload. The payload contains: sprint metadata + run info, task tallies (completed/stuck/human-needed/blocked counts), per-task summaries, parsed `human-review-queue.md` entries, compound-proposal status, and resolved `merge_strategy`.

If the agent reports `ERROR` (e.g., no active sprint), print the error and stop.

**Do not present the interactive review.** Mad-max skips executor.md Step 4 entirely — everything in the queue is left for the user to triage when they return.

---

## Step 4.5: Sprint-closer — phase 2 (finalize)

Spawn the **sprint-closer** agent with:
```
Phase: finalize
Decisions:
  merge_choice: "keep_open"
```

Wait for its `COMPLETED` or `ERROR` payload.

Handle the outcome:
- If `ERROR`, surface the error message and stop. Do not retry.
- Otherwise capture `head_sha` and the `merge.*` fields for Step 5. (`merge.outcome` will be `kept-open` given the hardcoded choice.)

The closer handles all staging and committing internally — do not run additional `git add` or `git commit` here.

---

## Step 5: Final summary

Render using fields from the closer's gather and finalize outputs and the sprint-verifier report:

```
## SoloFlow Mad-Max — Summary
- **Sprint:** {sprint.id}
- **Run branch:** {run.branch} (left open on {run.base_branch}; not merged)
- **Completed:** {stats.completed_count} / {initial_ready_count}
- **Stuck:** {stats.stuck_count}{if >0: ` — see .soloflow/active/stuck/`}
- **Human-needed:** {stats.human_needed_count}{if >0: ` — see .soloflow/human-review-queue.md`}
- **Blocked:** {stats.blocked_count}
- **Regressions flagged:** {sprint_verifier.regressions_count} (appended to human-review-queue)
- **Total executor loops:** {stats.total_executor_loops}
- **Head SHA:** {head_sha}

Next step: run /soloflow:executor to resume human review and merge, or inspect {run.branch} manually.
```

---

## Limitations

- **Context-limit prompts still exist.** If the orchestrator itself hits `SOLOFLOW CONTEXT CRITICAL`, it writes a checkpoint and asks the user to compact-or-exit. There's no unattended-safe alternative for an out-of-context main agent. If this matters for your run, pre-empt it by keeping batches small or splitting work across sessions.
- **Smoke baseline must be green.** Mad-max refuses to start on a red baseline because it cannot distinguish pre-existing failures from task-caused regressions. Use `/soloflow:executor` if you need to run on a known-red baseline.
- **Blocking deferred items must be resolved first.** Mad-max will not silently override `action_required` entries from prior sprints.
- **No auto-merge.** The run branch always stays open. Use `/soloflow:executor` to merge after human review.
