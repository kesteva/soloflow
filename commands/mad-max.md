---
description: Unattended backlog-drain mode — runs executor → verifier → code-reviewer loops on all ready tasks, logs stuck/human-needed, never prompts. Visual verify off; parallel by default.
argument-hint: "[optional: TASK-NNN TASK-NNN ... or IDEA-NNN to filter]"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:mad-max

Unattended variant of `/soloflow:sprint`. Drains every ready task in the backlog through the full per-task quality loop (executor → verifier → code-reviewer → test-writer) and leaves the run branch open for human review. Visual verification is unconditionally off and tasks run in parallel by default (floor of 3); end-of-sprint verification is skipped. **No interactive prompts during the run.**

Use this when you want to start a run and walk away. Use `/soloflow:sprint` when you want to review scope, deferred items, and merge choice interactively.

Arguments: **$ARGUMENTS** (optional — specific task IDs to include, or an `IDEA-NNN` to filter; if empty, include **all** ready tasks — this is drain mode, not a capped sprint).

---

## Model + limits resolution

Run once at the start, cache the result:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" --all
```

Mad-max spawns the same agents as `/soloflow:sprint`. Keys consumed:
- `models.sprint_initiator` / `models.executor` / `models.test_writer` / `models.sprint_closer` (fallback: `sonnet`)
- `models.verifier` / `models.code_reviewer` / `models.sprint_verifier` (fallback: `opus`)
- `limits.executor_retry_max` / `limits.checkpoint_interval` / `limits.context_limit_respawn_max` (fallbacks: 3)
- `limits.max_parallel_tasks` (fallback: 3) — controls how many task pipelines run concurrently per batch. `1` disables parallel mode.

Mad-max intentionally ignores `limits.max_sprint_tasks` — it drains every ready task, not a capped sprint. Reuse the cached values across respawns.

## Step 0.5: Hard-stop guardrails

Run these three checks in the orchestrator before spawning anything. Any failure prints a single-line reason and stops — mad-max never prompts.

1. **Not initialized.** If `.soloflow/` does not exist, print: `mad-max: SoloFlow not initialized. Run /soloflow:init first.` and stop.

2. **Active sprint.** Read `.soloflow/checkpoint.md` (if present) and glob `.soloflow/active/sprints/*/sprint.json`. If either indicates an active sprint (checkpoint says mid-execution, or any per-sprint sprint.json has `sprint.status: "active"`), print: `mad-max: active sprint {SPRINT-NNN} detected. Run /soloflow:sprint to resume or close it first.` and stop.

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
  - If any high-severity blocking entries exist → print `mad-max: {N} high-severity deferred item(s) from prior sprints require human resolution. Run /soloflow:sprint instead.` (list the task IDs from each high-severity blocking entry) and stop.
  - If only medium/low-severity blocking entries exist → print `mad-max: {N} non-high-severity blocking deferred item(s) from prior sprints (continuing — re-verify in /soloflow:sprint when ready).` and proceed. Do NOT stop.

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
- `execution_mode`: always `"parallel"` in mad-max. Mad-max is unattended, so per-task visual verification is unconditionally off (it requires a human to react to evidence and would also collide on Maestro device locks / web dev-server ports across worktrees). The existing `VISUAL_VERIFY: skip` prefix in pipeline step d fires whenever `EXECUTION_MODE == "parallel"`, so this single setting takes care of per-task visual skipping. End-of-sprint visual verification is also skipped — see Step 3.5.

After Step 1.5 completes, **override the cached `limits.max_parallel_tasks`** in working memory to `max(cached, 3)` for the remainder of this run. This guarantees ≥ 3-way parallelism even when the project config sets `limits.max_parallel_tasks: 1`. The override is in-memory only and is **not** written back to config. Users who genuinely want strictly-serial runs or per-task visual coverage must use `/soloflow:sprint` instead.

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
  execution_mode: "parallel"                 # mad-max is always parallel; per-task visual verify off via existing prefix
```

Parse the structured output. Handle:
- If `status: ERROR` → print the error and stop.
- On success, print: `mad-max: started {sprint_id} on run branch {run.branch} (base: {run.base_branch}@{run.base_sha short}) — {N} tasks queued.`

### Smoke baseline guardrail

If the phase 2 output includes `smoke_results` (non-null) AND the results show test failures or type-check failures, **abort**. Print:
```
mad-max: pre-sprint smoke baseline is red (tests: {failed} failed, type-check: {passed|failed}). Refusing to start an unattended run on a broken baseline. Run /soloflow:sprint (which will prompt you) or fix the baseline first.
```
Do not roll back the run branch — leave it for the user to investigate. Stop.

If `smoke_results` is null or all checks passed, proceed.

### Infra availability guardrail

If the phase 2 output includes `infra_check` with a non-empty `missing` list, **abort**. Print:

```
mad-max: sprint requires infrastructure that isn't available: {categories}. Affected tasks: {task_ids}. Refusing to start an unattended run that would silently skip tests. Install the tooling or run /soloflow:sprint to confirm the skip.
```

Do not roll back the run branch — leave it for the user to investigate. Stop.

Rationale: mad-max is unattended, so missing infra = silently skipped tests = exactly the class of regression mad-max should refuse. Users who know the gap and still want to proceed can use `/soloflow:sprint`, which prompts for explicit confirmation.

---

## Step 3: Execute the per-task loop

Mirror `commands/sprint.md` Step 3 exactly — including the batching wrapper (build-batch.js + worktree setup/merge) and the Per-Task Pipeline. The **only** behavioral deltas for mad-max:

- **No new early stops.** All terminal statuses (`STUCK`, `HUMAN_NEEDED`, `BLOCKED`, `merge-conflict`) write their report / queue entry / `sprint.json` update and continue to the next ready task.
- **No interactive checkpoint surfacing.** Checkpoints still get written every `checkpoint_interval` completed tasks (pipeline step g) for crash recovery, but mad-max never prompts about them during the run.
- **Force `EXECUTION_MODE = "parallel"` and floor `MAX_PARALLEL` at 3.** When sprint.md Step 3 reads `EXECUTION_MODE` from `sprint.json` and `MAX_PARALLEL` from cached `limits.max_parallel_tasks`, both come out of the Step 1.5 hardcoded decisions / in-memory override above. Per-task visual verification is therefore always skipped via the existing `VISUAL_VERIFY: skip` prefix in pipeline step d. Single-task batches naturally degrade to single-task pipelines via the existing batch fork — no special-casing needed.

Refer to `commands/sprint.md` Step 3 for the full procedure: Parallelism cap → build dependency graph → pick batch → SERIAL MODE (single task, no worktree) or PARALLEL MODE (N ≥ 2 tasks, one worktree per task, batched parallel Agent calls per phase, sequential merge-back + settle from the main worktree) → Per-Task Pipeline definition (lettered steps a, a2, b, c, d, e, f, f2, f3, g, h).

The same `WORKTREE_ROOT:` prefix injection, `worktree-setup.js` / `worktree-merge.js` calls, and conflict-handling rules apply unchanged.

**End of loop.** Sprint status remains `"active"` until the closer's finalize phase flips it.

---

## Step 3.5: End-of-sprint verification (skipped in mad-max)

Skip this step entirely. Mad-max is unattended, so end-of-sprint visual verification has no human to react to its evidence and would not block the run anyway. Print one line:

```
mad-max: skipping end-of-sprint visual verification (unattended run; use /soloflow:sprint or /soloflow:visual-verify after the run for visual coverage).
```

Do not spawn `shadow-sprint-verifier`. Do not write `.soloflow/active/sprint-verification.md`. The sprint-closer's gather phase already handles the missing file (tallies sprint-level mobile/web as `not_applicable` with note "sprint-verifier did not run"), so Step 5's summary still renders cleanly. There is no `regressions_count` to capture in mad-max.

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

Render using fields from the closer's gather and finalize outputs (sprint-verifier never runs in mad-max — see Step 3.5):

```
## SoloFlow Mad-Max — Summary
- **Sprint:** {sprint.id}
- **Run branch:** {run.branch} (left open on {run.base_branch}; not merged)
- **Completed:** {stats.completed_count} / {initial_ready_count}
- **Stuck:** {stats.stuck_count}{if >0: ` — see .soloflow/active/stuck/`}
- **Human-needed:** {stats.human_needed_count}{if >0: ` — see .soloflow/human-review-queue.md`}
- **Blocked:** {stats.blocked_count}
- **Regressions flagged:** skipped (no end-of-sprint verification in mad-max)
- **Total executor loops:** {stats.total_executor_loops}
- **Total code review rounds:** {stats.total_code_review_rounds}
- **Visual coverage:**
  - Per-task mobile: {per_task.mobile.pass} pass / {per_task.mobile.fail} fail / {per_task.mobile.not_applicable} N/A / {per_task.mobile.skipped_user_preference} skipped (user pref) / {per_task.mobile.skipped_unable} skipped (unable)
  - Per-task web:    {per_task.web.pass} pass / {per_task.web.fail} fail / {per_task.web.not_applicable} N/A / {per_task.web.skipped_user_preference} skipped (user pref) / {per_task.web.skipped_unable} skipped (unable)
  - Per-task macos:  {per_task.macos.pass} pass / {per_task.macos.fail} fail / {per_task.macos.not_applicable} N/A / {per_task.macos.skipped_user_preference} skipped (user pref) / {per_task.macos.skipped_unable} skipped (unable)
  - Sprint-level:    mobile={sprint_level.mobile}{note if present}, web={sprint_level.web}{note if present}, macos={sprint_level.macos}{note if present}
- **Head SHA:** {head_sha}

Next step: run /soloflow:sprint to resume human review and merge, or inspect {run.branch} manually.
```

---

## Limitations

- **Context-limit prompts still exist.** If the orchestrator itself hits `SOLOFLOW CONTEXT CRITICAL`, it writes a checkpoint and asks the user to compact-or-exit. There's no unattended-safe alternative for an out-of-context main agent. If this matters for your run, pre-empt it by keeping batches small or splitting work across sessions.
- **Smoke baseline must be green.** Mad-max refuses to start on a red baseline because it cannot distinguish pre-existing failures from task-caused regressions. Use `/soloflow:sprint` if you need to run on a known-red baseline.
- **High-severity deferred items must be resolved first.** Mad-max will not silently override `action_required` entries (Actions or Testing bucket) from prior sprints when their severity is `high`. Medium/low-severity blocking entries are surfaced but do not stop the run.
- **No auto-merge.** The run branch always stays open. Use `/soloflow:sprint` to merge after human review.
- **Visual verification is unconditionally off.** Both per-task and end-of-sprint visual verification are skipped in mad-max — there is no human in the loop to react to the evidence, and parallel worktrees would collide on Maestro device locks / web dev-server ports anyway. After the run, use `/soloflow:sprint` for an interactive triage pass on the open run branch, or `/soloflow:visual-verify` to walk visual checks manually.
- **Parallelism is forced.** Mad-max overrides `limits.max_parallel_tasks` to a floor of 3 in working memory for the duration of the run (config is not modified). Users who want strictly-serial runs must use `/soloflow:sprint` instead.
