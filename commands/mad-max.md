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

## Model resolution (applies to every Agent spawn below)

Before invoking the Agent tool, resolve `models.<name>` per the three-tier
recipe in [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
and pass the resolved value as the Agent tool's `model` parameter.

Mad-max spawns the same agents as `/soloflow:executor`:
- `sprint-initiator` → `models.sprint_initiator` (fallback: `sonnet`)
- `executor` → `models.executor` (fallback: `sonnet`)
- `verifier` → `models.verifier` (fallback: `opus`)
- `code-reviewer` → `models.code_reviewer` (fallback: `opus`)
- `test-writer` → `models.test_writer` (fallback: `sonnet`)
- `sprint-verifier` → `models.sprint_verifier` (fallback: `opus`)
- `sprint-closer` → `models.sprint_closer` (fallback: `sonnet`)

Cache the resolved values at the start of the run and reuse them for respawns.

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
- Filter `deferred_items.blocking` to entries with `severity: high`:
  - If any high-severity blocking entries exist → print `mad-max: {N} high-severity deferred item(s) from prior sprints require human resolution. Run /soloflow:executor instead.` (list the task IDs from each high-severity blocking entry) and stop.
  - If only medium/low-severity blocking entries exist → print `mad-max: {N} non-high-severity blocking deferred item(s) from prior sprints (continuing — re-verify in /soloflow:executor when ready).` and proceed. Do NOT stop.

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

### Infra availability guardrail

If the phase 2 output includes `infra_check` with a non-empty `missing` list, **abort**. Print:

```
mad-max: sprint requires infrastructure that isn't available: {categories}. Affected tasks: {task_ids}. Refusing to start an unattended run that would silently skip tests. Install the tooling or run /soloflow:executor to confirm the skip.
```

Do not roll back the run branch — leave it for the user to investigate. Stop.

Rationale: mad-max is unattended, so missing infra = silently skipped tests = exactly the class of regression mad-max should refuse. Users who know the gap and still want to proceed can use `/soloflow:executor`, which prompts for explicit confirmation.

---

## Step 3: Execute the per-task loop

Mirror `commands/executor.md` Step 3 exactly. The **only** behavioral delta for mad-max:

- **No new early stops.** All terminal statuses (`STUCK`, `HUMAN_NEEDED`, `BLOCKED`) write their report / queue entry / `sprint.json` update and continue to the next ready task.
- **No interactive checkpoint surfacing.** Checkpoints still get written every `checkpoint_interval` completed tasks (Step 3.g) for crash recovery, but mad-max never prompts about them during the run.

Concretely, for each ready task (dependencies satisfied):

Initialize per-task counters in working memory: `executor_loops = 0` (incremented in step e on `NEEDS_CHANGES` retry) and `code_review_rounds = 0` (incremented in step f on `IMPROVEMENTS_NEEDED` retry). Both are written into the done-report frontmatter at step f3. CONTEXT_LIMIT respawns and `IMPROVEMENTS_NEEDED` re-verifies do not count toward `executor_loops`.

a. Set task status to in_progress: `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/update-task-status.js" TASK-{NNN} in_progress`.

a2. **Locate the plan file** via `.soloflow/active/plans/**/TASK-{NNN}-plan.md` (matches nested epic folders and flat orphan paths; excludes `EPIC-*.md`). Read the plan's `epic` frontmatter field — this determines where downstream reports go.

b. Spawn **executor** agent with the plan content. Wait for result.

c. Handle executor result:
  - **COMPLETED** → proceed to verification.
  - **BLOCKED** → run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} blocked --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`, continue to next task.
  - **STUCK** → write stuck report to `.soloflow/active/stuck/{epic}/TASK-{NNN}-stuck.md` (or flat if no epic), then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report <that path> --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`, continue.
  - **CONTEXT_LIMIT** → pass handoff to a fresh executor (up to `context_limit_respawn_max`, default 3). If exhausted, treat as STUCK. Same protocol as `commands/executor.md:135-141`.

d. Spawn **verifier** with plan + executor report. Wait for verdict.

e. Handle verifier verdict:
  - **APPROVED** / **APPROVED_WITH_DEFERRED** → proceed to code review (step f). Deferred checks already queued in `human-review-queue.md` by the verifier.
  - **NEEDS_CHANGES** → if `executor_loops < executor_retry_max` (default 3), increment `executor_loops` and re-spawn executor with verifier feedback. Otherwise write stuck report (same path rule as step c's STUCK) and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report <that path> --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`, continue to next task.
  - **HUMAN_NEEDED** → append entry to `.soloflow/human-review-queue.md`, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} human_needed --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`, continue.
  - **CONTEXT_LIMIT** → respawn with handoff (same budget).

f. Spawn **code-reviewer** with the plan + executor's changed files list. Wait for verdict.
  - **CLEAN** → proceed to step f2.
  - **IMPROVEMENTS_NEEDED** (first time only) → increment `code_review_rounds`, re-spawn executor with review feedback, then re-verify. Does not consume executor retry budget.
  - **SECURITY_ISSUE** → append entry to `.soloflow/human-review-queue.md`, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} human_needed --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`, continue.
  - **CONTEXT_LIMIT** → respawn with handoff.

f2. **Test writing.** Spawn the **test-writer** agent with the plan, executor's changed files, and code-reviewer's report. Wait for result.
  - **TESTS_WRITTEN** → run the project's test suite via Bash. If the new tests pass, proceed. If they fail, re-spawn test-writer with failure output (one retry). If still failing, log a finding to `.soloflow/active/findings.md` and proceed.
  - **NO_TESTS_NEEDED** / **NO_TEST_INFRA** → proceed.
  - **CONTEXT_LIMIT** → respawn with handoff.

f3. Write done report to `.soloflow/archive/done/{epic}/TASK-{NNN}-done.md` (or flat) using the frontmatter spec defined in `commands/executor.md` step f3 — populate `executor_loops` and `code_review_rounds` from the per-task counters tracked above, and copy `visual_mobile` / `visual_web` verbatim from the most recent verifier's Visual Verification report block. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} done --done-report <that path> --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md` — this removes the task from `sprint.json` and commits `chore(TASK-{NNN}): done`. Run the epic archival check: if the plan had an epic and no TASK-*.md files remain under `.soloflow/active/plans/{epic}/` and no sprint tasks from that epic remain, **log to `.soloflow/active/findings.md`** — `epic {epic} has no remaining tasks; candidate for archival` — and do NOT prompt. Archival waits for human review.

g. Every `checkpoint_interval` completed tasks (default 3), write checkpoint to `.soloflow/checkpoint.md`.

h. **State commit happens inside `settle-task.js`** (invoked by each terminal verdict above). The orchestrator does not run `git add` / `git commit` itself for per-task state.

**End of loop.** Sprint status remains `"active"` until the closer's finalize phase flips it.

---

## Step 3.5: End-of-sprint verification

Spawn the **sprint-verifier** agent with: sprint ID, base SHA (from `sprint.json`'s `run.base_sha`), the list of completed tasks with their plans and changed files, and the resolved visual verification config. Wait for its report.

Handle the report:
- Append any regressions (visual or integration) to `.soloflow/human-review-queue.md` with the failure details, evidence, and suspected responsible task.
- Stage `.soloflow/active/sprint-verification.md` (sprint-closer reads it for sprint-level visual coverage) and commit any `.soloflow/` state changes with `chore(SPRINT-{NNN}): end-of-sprint verification`. Use `git add` with explicit paths — never `git add -A`.

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
- **Total code review rounds:** {stats.total_code_review_rounds}
- **Visual coverage:**
  - Per-task mobile: {per_task.mobile.pass} pass / {per_task.mobile.fail} fail / {per_task.mobile.not_applicable} N/A / {per_task.mobile.skipped_user_preference} skipped (user pref) / {per_task.mobile.skipped_unable} skipped (unable)
  - Per-task web:    {per_task.web.pass} pass / {per_task.web.fail} fail / {per_task.web.not_applicable} N/A / {per_task.web.skipped_user_preference} skipped (user pref) / {per_task.web.skipped_unable} skipped (unable)
  - Sprint-level:    mobile={sprint_level.mobile}{note if present}, web={sprint_level.web}{note if present}
- **Head SHA:** {head_sha}

Next step: run /soloflow:executor to resume human review and merge, or inspect {run.branch} manually.
```

---

## Limitations

- **Context-limit prompts still exist.** If the orchestrator itself hits `SOLOFLOW CONTEXT CRITICAL`, it writes a checkpoint and asks the user to compact-or-exit. There's no unattended-safe alternative for an out-of-context main agent. If this matters for your run, pre-empt it by keeping batches small or splitting work across sessions.
- **Smoke baseline must be green.** Mad-max refuses to start on a red baseline because it cannot distinguish pre-existing failures from task-caused regressions. Use `/soloflow:executor` if you need to run on a known-red baseline.
- **High-severity deferred items must be resolved first.** Mad-max will not silently override `action_required` entries from prior sprints when their severity is `high`. Medium/low-severity blocking entries are surfaced but do not stop the run.
- **No auto-merge.** The run branch always stays open. Use `/soloflow:executor` to merge after human review.
