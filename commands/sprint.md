---
description: Run an execution sprint over ready tasks in the backlog
argument-hint: [TASK-NNN... | IDEA-NNN] [--quick | --no-code-review | --no-verification]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:sprint

Phase 3 of the SoloFlow pipeline. Creates a sprint from ready tasks in the backlog and runs the executor → verifier → code-reviewer loop until the sprint is complete.

Arguments: **$ARGUMENTS** (optional — specific task IDs to include, or an `IDEA-NNN` to filter; if empty, include all ready tasks up to resolved `limits.max_sprint_tasks`). May also include review/verification flags — see Step 0.4.

---

## Step 0.4: Parse flags

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sprint/parse-flags.js" --args "$ARGUMENTS"
```

The script returns JSON `{ positional, flags, effective, summary_line }`. Consume:
- `positional` → effective `$ARGUMENTS` used by Step 1.5d and elsewhere.
- `effective.per_task_verification_enabled`, `per_task_code_review_enabled`, `sprint_verification_enabled`, `sprint_code_review_enabled` → the four booleans used by downstream steps.
- `summary_line` → print it (only if non-empty) so the user sees what's disabled.

If the script exits with code 2, stdout contains `{"error": "..."}`. Print the error message and stop — this is the fail-closed path for unknown flags like `--no-codereview`.

Recognized flags:
- `--quick` — shorthand for `--no-code-review --no-verification`
- `--no-code-review` — disables per-task (Step 3.f) and end-of-sprint (Step 3.6) code review
- `--no-verification` — disables per-task (Step 3.d) and end-of-sprint (Step 3.5) verification

The flag layer sits on top of config resolution; the script already folds the resolved `code_review.enabled` and `sprint_code_review.enabled` config values into the returned booleans.

---

## Model + limits resolution (applies throughout this command)

Run once at the start of the run and cache the result:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" --all
```

Use the resolved object for every Agent spawn's `model` parameter and wherever limits appear below. Keys consumed:

Model mapping (fallback matches the agent's frontmatter `model:`):
- `models.sprint_initiator` / `models.executor` / `models.test_writer` / `models.sprint_closer` → `sonnet`
- `models.verifier` / `models.code_reviewer` / `models.sprint_verifier` / `models.sprint_code_reviewer` → `opus`

Limits (fallbacks):
- `limits.executor_retry_max` → 3 (max `NEEDS_CHANGES` re-spawns in pipeline step e)
- `limits.checkpoint_interval` → 3 (tasks between checkpoint writes in pipeline step g)
- `limits.max_sprint_tasks` → 10 (cap on `$ARGUMENTS`-less sprint scope)
- `limits.context_limit_respawn_max` → 3 (max `CONTEXT_LIMIT` respawns per agent per task)
- `limits.max_parallel_tasks` → 3 (max task pipelines executed concurrently in a batch; `1` = strictly serial)

Reuse the cached config across respawns on `CONTEXT_LIMIT` / `NEEDS_CHANGES` / `IMPROVEMENTS_NEEDED`.

## Sprint Initiation (Steps 0.5–2.8)

Sprint initiation uses the **sprint-initiator** sub-agent in two phases to keep orchestrator context lean. The agent handles file I/O, config resolution, git operations, and test runs; the orchestrator handles all user prompts between phases.

## Step 0.45: Shadow agent drift check

MCP-dependent subagents (`shadow-verifier`, `shadow-sprint-verifier`, `shadow-researcher`, `shadow-roadmap-researcher`) live at `.claude/agents/shadow-*.md`, pinned to the plugin version that was current when `/soloflow:init` last ran. If the plugin has updated since, the shadows may be missing fixes — including any changes to the verifier's Level 2 logic, the researcher's context7 probe, etc.

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/init/shadow-agents.js" --mode check
```

Parse the JSON output. Three paths:

1. **Script failed** (non-zero exit, `CLAUDE_PLUGIN_ROOT` unset, plugin manifest missing) → print a one-line warning (`⚠ Shadow drift check skipped: {error}. Re-run /soloflow:init after the plugin fully loads.`) and proceed to Step 0.5. Don't block — the sprint can still run on whatever shadows are present (or on the plugin versions if none are installed).

2. **`drifted: false`** → print `✓ Shadow agents current (v{plugin_version})` and proceed silently.

3. **`drifted: true`** → list the drift in the prompt body, then **AskUserQuestion**:
   - **Question body:** `SoloFlow plugin v{plugin_version} is newer than the shadow agents installed in .claude/agents/:\n{for each needs_update entry: "  {name} — {status} (installed v" + recorded_version + " or untracked)"}\n\nThe shadows control how visual verification and research agents behave. Stale shadows may be missing fixes from the current plugin. Update now?`
   - **Header:** `Shadow sync`
   - **Options:**
     - `Update now` — run `node "${CLAUDE_PLUGIN_ROOT}/scripts/init/shadow-agents.js" --mode sync --set all`, print the result summary (`✓ Synced: {list}` + any `⚠ Failed: {list}`), then print `ℹ Shadow updates take effect on the NEXT session — current session still uses the previously-loaded subagents.` and proceed to Step 0.5.
     - `Skip — run with stale shadows` — print `⚠ Running with stale shadow agents. Run /soloflow:sync-agents before the next sprint to pick up plugin fixes.` and proceed to Step 0.5.
     - `Abort` — stop execution and instruct the user to run `/soloflow:sync-agents` manually.

This check is advisory, never blocking — a drift-detected sprint still runs if the user opts to skip. The check never touches `not_installed` shadows (those are surfaced as status but not prompted about; the user may have visual verification disabled, in which case `shadow-verifier.md`/`shadow-sprint-verifier.md` shadows are intentionally absent).

## Step 0.5: Checkpoint & branch resume

These checks happen in the orchestrator before any agent spawn — they may skip initiation entirely.

1. Read `.soloflow/checkpoint.md` — if it indicates an active sprint mid-execution, use **AskUserQuestion** (question: "Sprint {SPRINT-NNN} is in progress. Resume it or start fresh?", options: **Resume** / **Start fresh**). Do not print the choice as prose.
   - If resume: load `sprint.json` and skip directly to Step 3.
   - If fresh: archive the stale sprint and continue.
2. **Run branch resume check:** if `.soloflow/active/sprints/{sprint_id}/sprint.json` exists and contains a `run` object, verify `git rev-parse --abbrev-ref HEAD` matches `run.branch`. If it doesn't match, do NOT silently reattach — use **AskUserQuestion**: **Checkout the run branch** / **Clear the run record and continue on current branch** / **Abort**. Act on the answer before proceeding.

## Step 1: Gather sprint context

Spawn the **sprint-initiator** agent with:
```
Phase: gather
```

Parse its structured output. Handle:
- If `status: ERROR` → report the error and stop.
- If `initialized: false` → report "SoloFlow not initialized. Run `/soloflow:init` first." and stop.
- If `backlog.ready_count == 0` → report "No ready tasks in backlog. Run `/soloflow:planner IDEA-NNN` first." and stop.

The gathered data contains: ready tasks (with epic info), resolved `branch_per_run` config, worktree status, parsed deferred items, next sprint ID, and smoke eligibility.

## Step 1.5: Resolve interactive decisions

Use the gathered data to run all user prompts. These stay in the orchestrator because sub-agents cannot use AskUserQuestion.

### 1.5a: Branching preference

1. Read `branch_per_run` from gathered data.
2. If `always` → set `create_branch = true`, skip prompt.
3. If `never` → set `create_branch = false`, skip prompt.
4. If `prompt` → use **AskUserQuestion** with:
   - "Create a run branch (recommended)" — isolates this run so `main` stays clean until human review.
   - "Stay on current branch" — commits land on the current branch directly.
   - "Create a run branch and remember this choice" — same as option 1; sets `remember_branch_choice = true`.

### 1.5b: Guardrails

- If `create_branch = true` and gathered `worktree.is_dirty = true`, stop and tell the user to commit or stash their working tree before starting a run.
- If `create_branch = false`, gathered `worktree.current_branch` is `main` or `master`, and the sprint-to-be has more than one task, warn the user and re-prompt — they can still explicitly choose "Stay on current branch" to override.

### 1.5c: Deferred ground-truth items

1. If gathered `deferred_items.blocking` is non-empty, use **AskUserQuestion**:

   `{N} deferred ground-truth check(s) from prior sprints remain unresolved:`

   List each blocking entry: task ID, action, and blocked checks. Options:
   - **Resolve now** — the user resolves the items before continuing. After they confirm, re-read `human-review-queue.md` and re-check. If blocking items remain, re-prompt.
   - **Override with justification** — the user provides a one-line justification. Collect `overrides` list (task_id + justification pairs) for phase 2.
   - **Abort** — stop execution.

2. If gathered `deferred_items.advisory_count > 0`, print: `{N} advisory deferred item(s) from prior sprints (non-blocking).`

### 1.5d: Sprint scope

Use gathered backlog data. If `$ARGUMENTS` names specific task IDs or an `IDEA-NNN`, use those directly. Otherwise, use **AskUserQuestion** with the sprint scope:

`{ready_count} ready tasks in backlog. How many to include in this sprint?`

Options (label `{M}` = resolved `limits.max_sprint_tasks`, fallback 10):
- **Next 5** — first 5 ready tasks by ID order *(omit if fewer than 5; show actual count instead)*
- **Next {M}** — first `{M}` ready tasks *(omit if fewer than `{M}` ready, or if `{M}` == 5)*
- **All tasks in {epic name}** — all ready tasks in the natural next epic *(only if an epic with ready tasks exists)*
- **Other** — user specifies task IDs or a count

If no tasks were selected, stop.

### 1.5d.1: Transitive scope expansion

The user's selection (whether from `$ARGUMENTS` or the 1.5d prompt) is a starting set, not the final scope. Expand it transitively over `depends_on` so:
- A selected task pulls in any of its still-`ready` deps still sitting in the backlog (**backward**) — without this, the per-task scheduler in `scripts/sprint/ready-tasks.js` would silently treat the missing dep as externally-complete and run the dependent task with un-done prerequisites.
- A selected task pulls in any backlog-`ready` task whose only blockers are now in scope (**forward**) — these dependents would otherwise be stranded in the backlog even though the sprint completes their unblocker.

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sprint/expand-selection.js" --initial TASK-NNN,TASK-MMM,...
```

Parse the JSON output `{ initial, added_backward, added_forward, expanded, reasons }`. Behavior:
- If the script exits non-zero, print its stderr and stop (fail closed; e.g. an `$ARGUMENTS`-supplied task ID that isn't ready in backlog).
- Replace `selected_task_ids` with `expanded` for Step 2's `Phase: execute` payload.
- If `added_backward.length + added_forward.length > 0`, print one notice line — no extra prompt:
  ```
  Pulled in {N} dependent task(s): {for each id in added_backward ∪ added_forward: "TASK-NNN ({reasons[id].direction} via {reasons[id].via.join(',')})"}
  ```
  Independent ready tasks are never auto-added — only tasks with at least one dependency edge to the selected set.

### 1.5e: Execution mode (serial vs parallel)

Per-task visual verification (Maestro / Playwright) cannot safely run across parallel worktrees — Maestro holds a per-device lock, and web dev servers bind to fixed ports. The user chooses up-front which trade-off applies to this sprint.

1. Skip this prompt entirely and set `execution_mode = "serial"` if **any** of the following is true:
   - Resolved `limits.max_parallel_tasks <= 1` (parallelism already disabled globally)
   - `selected_task_ids.length <= 1` (nothing to parallelize)
2. Otherwise, use **AskUserQuestion** with:
   - **Question body:** `Run {N} tasks serially or in parallel?\n\nSerial keeps per-task visual verification on (Maestro / Playwright). Parallel runs up to {MAX_PARALLEL} tasks concurrently in isolated worktrees but skips per-task visual verify — end-of-sprint visual verification still runs in a single pass.` (substitute the resolved `limits.max_parallel_tasks` for `{MAX_PARALLEL}` and the selected task count for `{N}`).
   - **Header:** `Execution mode`
   - **Options:**
     - `Serial — full per-task visual verify` → `execution_mode = "serial"`
     - `Parallel — skip per-task visual verify` → `execution_mode = "parallel"`

The chosen mode flows into Step 2 and is persisted on `sprint.json`. Checkpoint-resume reads it back in Step 3, so this prompt fires at most once per sprint.

### 1.5f: Dev server

Read `dev_server` from gather output.

- If `null` (`verification.dev_server.enabled` is false) — set `dev_server_action = null` and skip this prompt. The sprint runs with no dev-server management.
- Otherwise branch on `online` × `managed_by_sprint`:
  - **`online: false`, `managed_by_sprint: false`** → use **AskUserQuestion**:
    - **Header:** `Dev server`
    - **Question body:** `{name} is not running. Start it under the sprint so agents can read bundler errors?`
    - **Options:**
      - `Start under sprint (Recommended)` → `dev_server_action = "start"`
      - `Skip` → `dev_server_action = "skip"`
  - **`online: true`, `managed_by_sprint: false`** → use **AskUserQuestion**:
    - **Header:** `Dev server`
    - **Question body:** `{name} is already running outside SoloFlow. Kill it and restart under the sprint so agents can read its output? (Choosing 'Keep external' leaves your process alone but agents won't see its output.)`
    - **Options:**
      - `Restart under sprint (Recommended)` → `dev_server_action = "restart"`
      - `Keep external` → `dev_server_action = "keep"`
      - `Skip` → `dev_server_action = "skip"`
  - **`online: true`, `managed_by_sprint: true`** → silent; set `dev_server_action = "keep"`.
  - **`online: false`, `managed_by_sprint: true`** → print `Sprint's prior dev_server is no longer responding; will start a fresh one.` and set `dev_server_action = "start"`.

`dev_server_action` is consumed in Step 2.5 (after sprint-initiator phase 2). It is informational only and is NOT passed to sprint-initiator phase 2 — process lifecycle stays in the orchestrator.

## Step 2: Execute sprint initiation

Spawn the **sprint-initiator** agent with:
```
Phase: execute
Decisions:
  create_branch: {resolved value}
  selected_task_ids: [TASK-NNN, ...]
  sprint_id: "{gathered sprint_id_next}"
  overrides: [{task_id, justification}, ...]  # empty if no overrides
  remember_branch_choice: {true|false}
  skip_smoke: {gathered skip_smoke value}
  execution_mode: "{serial|parallel}"        # from Step 1.5e
```

Parse its structured output. Handle:
- If `status: ERROR` → report the error and stop.
- If `run` is non-null, print: `Run branch: {run.branch} (base: {run.base_branch}@{run.base_sha short})`.

## Step 2.5: Dev server start/restart

If `dev_server_action` (from Step 1.5f) is `"skip"`, `"keep"`, or `null`, proceed to Step 2.8 with no action.

Resolve the dev-server config keys:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" \
    --key verification.dev_server.name --fallback "dev-server" \
    --key verification.dev_server.start_command --fallback "" \
    --key verification.dev_server.probe_url --fallback "" \
    --key verification.dev_server.probe_port --fallback 0 \
    --key verification.dev_server.startup_timeout_seconds --fallback 30
```

If `dev_server_action == "restart"`:
1. Run `lsof -ti :{probe_port}` via Bash. For each PID returned, run `kill {pid}`. After 3s, `kill -0 {pid}` to verify exit; `kill -9 {pid}` if still alive.
2. Fall through to start.

If `dev_server_action == "start"` (or fell through from restart):
1. Call **Bash with `run_in_background: true`** invoking `{start_command}` from the repo root. Capture the bash result — extract `task_id` and the output file path that the harness assigns. Do NOT use `Bash` without `run_in_background: true` here; the process must outlive the tool call.
2. Poll readiness: every 1s up to `startup_timeout_seconds`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/sprint/probe-dev-server.js" --probe-only` via Bash and read the JSON `online` field. Stop polling on the first `true`. Track `final_online`.
3. Update `.soloflow/active/sprints/{sprint_id}/sprint.json` to add a `dev_server` block:
   ```json
   "dev_server": {
     "name": "{name}",
     "task_id": "{task_id}",
     "output_path": "{output_path}",
     "started_at": "{ISO timestamp}",
     "online": true|false
   }
   ```
   Use a Read+Edit pair (no script helper exists for partial sprint.json patches). Do NOT commit this update — `task_id` is session-state, not durable. The block will be removed at sprint close.
4. If `final_online == false` (probe never returned 200 within `startup_timeout_seconds`), do not abort — surface the failure in Step 2.8.

## Step 2.8: Smoke and infra decision

Surface four orthogonal signals from the phase 2 output: the smoke baseline, task-level infra availability, per-task plan-declared prerequisites, and dev-server start state (Step 2.5). Present a single **AskUserQuestion** only if at least one of the following is true:
- `smoke_results` is non-null AND (any failures OR `smoke_results.missing_infra` is non-empty)
- `infra_check.missing` is non-empty
- `infra_check.task_prerequisites` contains any entry with `status: "fail"` or `status: "timeout"` (blocking or advisory)
- `dev_server_action` was `"start"` or `"restart"` AND `sprint.json.dev_server.online == false` (Step 2.5 failed to bring it online)

If none of the above triggers a prompt:
- If `dev_server_action` was `"start"` or `"restart"` AND `sprint.json.dev_server.online == true`, print `{name} running under sprint (task_id: {task_id}; agents can read output_path from sprint.json.dev_server.output_path).`
- Print `Smoke baseline clean; all required infra available; all task prerequisites satisfied.` and proceed to Step 3 with no prompt.

Let `gated_task_ids` = the set of task IDs in `task_prerequisites` with at least one failing entry where `blocking: true`. This set drives the gating behavior below.

### Prompt body

Compose the question body from these sections (omit a section if it has nothing to report):

**Smoke baseline** (only if `smoke_results` is non-null):
- Test results: `{passed} tests passed, {failed} failed` or `No test suite found`
- Type checker: `Type check passed` / `Type check failed` / `No type checker configured`
- If `smoke_results.missing_infra` is non-empty: `Missing test config: {list} — these ground-truth checks are uncovered for this sprint.`

**Task-level infra** (only if `infra_check.missing` is non-empty):
- Header: `{N} task(s) in this sprint expect infrastructure that isn't available:`
- Per `missing` entry: `- {category} — {reason}. Affected: {task_id list}. Tests that will be skipped: {flattened test_targets}.`
- Trailer: `Continuing will skip these checks; verifier will mark them SKIPPED — {category} not available.`

**Dev server** (only if `dev_server_action` was `"start"` or `"restart"` AND `sprint.json.dev_server.online == false`):
- `{name} failed to come online within {startup_timeout_seconds}s after {dev_server_action}. Output captured at {sprint.json.dev_server.output_path}.`

**Task prerequisites** (only if `task_prerequisites` contains any `fail`/`timeout` entry):
- Blocking failures header (only if `gated_task_ids` is non-empty): `{N} task(s) have failing BLOCKING prerequisites and will be gated out of the sprint if you continue:`
  - Per gated task, per failing blocking entry: `- {task_id}: {description} — suggested fix: {fix}`
- Advisory failures header (only if any non-blocking `fail`/`timeout` exist): `{N} advisory prereq check(s) failed (task will still run, executor may hit the failure):`
  - Per advisory: `- {task_id}: {description} — suggested fix: {fix}`

### Options

- **Continue sprint** — proceed to Step 3. Two side effects before Step 3 begins:
  1. If `infra_check.missing` was non-empty, append one line to the sprint's findings file (`.soloflow/active/findings/{sprint_id}-findings.md`) via Bash: `SPRINT-{sprint_id} started with missing infra: {categories}; tests deferred.`
  2. **If `gated_task_ids` is non-empty, gate those tasks out.** For each gated task:
     a. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" {task_id} blocked --touched .soloflow/active/findings/{sprint_id}-findings.md` — matches the BLOCKED handling in Step 3 and removes the task from the active sprint loop.
     b. Append to `.soloflow/human-review-queue.md` one entry per failing blocking prereq on that task. Use `bucket: actions` — installing/configuring a missing prereq is operational work the user performs before re-running the sprint.
        ```yaml
        - task: {task_id}
          type: action_required
          bucket: actions
          action: "{fix}"
          blocked_checks: ["prerequisite: {description}"]
          level: "ground_truth"
          severity: "high"
        ```
     c. Append one line to the sprint's findings file: `{task_id} gated: failing blocking prereq ({description}).`
     After gating, if `sprint.json.tasks` is now empty, print `All selected tasks were gated out — nothing to execute. Re-run /soloflow:sprint after installing the missing prerequisites.` and stop instead of proceeding to Step 3.
- **Abort** — stop execution so the user can install the missing tooling, fix the baseline, or resolve prereqs, then re-run `/soloflow:sprint`.

This step does NOT fix failures — it only surfaces baseline state and lets the user confirm a known-reduced verification surface.

## Step 3: Execute the Loop

**Parallelism cap.** Resolved `limits.max_parallel_tasks` (fallback `3`) controls how many task pipelines run concurrently per batch. Resolve it once here and cache it as `MAX_PARALLEL`. Cache `RUN_BRANCH` from `sprint.json`'s `run.branch` (if `run` is null, use the result of `git symbolic-ref --short HEAD`). When `MAX_PARALLEL == 1`, all batches degrade to single-task pipelines with no worktree overhead — this is the strict-serial kill switch.

**Execution mode.** Read `sprint.json`'s `sprint.execution_mode` into `EXECUTION_MODE` (fallback `"serial"` if absent — preserves prior-schema sprints on resume). If `EXECUTION_MODE == "serial"`, force `MAX_PARALLEL = 1` for the rest of this run, overriding the config value. This is the kill switch that makes the user's Step 1.5e choice binding even when config would otherwise allow parallelism. When `EXECUTION_MODE == "parallel"`, every shadow-verifier spawn in pipeline step d must be prefixed with `VISUAL_VERIFY: skip` (see pipeline step d).

1. **Build dependency graph** from tasks' `depends_on` fields. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sprint/ready-tasks.js" [--completed TASK-AAA,TASK-BBB]
   ```
   The script returns `{ ready, in_progress, blocked, cycles }`. Tasks in `ready` are immediately available.

2. **Pick the next batch.**
   - If `MAX_PARALLEL == 1`, set `batch = [ready[0]]`. Skip to step 3 (SERIAL MODE).
   - Else run `node "${CLAUDE_PLUGIN_ROOT}/scripts/sprint/build-batch.js" --ready {comma-joined ready IDs} --max {MAX_PARALLEL}`. Parse `{ batch, deferred, reasons }`.
     - If `batch.length <= 1`, proceed in SERIAL MODE with that one task.
     - If `batch.length >= 2`, proceed in PARALLEL MODE. Remember the batch for step 4.

3. **SERIAL MODE — single-task pipeline.** Run the Per-Task Pipeline (section below) for the single batch task with **no `WORKTREE_ROOT` prefix**. The executor commits directly on `RUN_BRANCH`; the merge step (step 4.c) is a no-op in this mode. After the pipeline completes, loop back to step 1.

4. **PARALLEL MODE — batch of N ≥ 2 pipelines.**

   **4.a — Set up per-task worktrees** (sequential; git serializes these anyway). For each task `T` in `batch`:
   1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/update-task-status.js" T in_progress`
   2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/worktree-setup.js" T --base-branch "$RUN_BRANCH"` — capture the JSON output. Remember `WT_T = .worktree`, `TB_T = .branch` per task.
   3. Locate T's plan file via `.soloflow/active/plans/**/TASK-NNN-plan.md` (same glob as pipeline step a2). Read the plan content into `PLAN_T`. Read the plan's `epic` frontmatter field into `EPIC_T`.

   **4.b — Run each phase as a batched parallel Agent call.** For every phase below, issue one message containing one `Agent` tool call per still-alive task. Prefix each prompt with:
   ```
   WORKTREE_ROOT: {WT_T}

   {phase-specific prompt payload}
   ```
   Wait for all calls in the phase to return before advancing.

   Phases (skip the same way SERIAL does for disabled per-task verification / code-review):

   1. **Executor.** Payload = `PLAN_T`. On return, classify per pipeline step c. For `COMPLETED`, keep T alive for phase 2. For `BLOCKED` or `STUCK`: write the stuck report (if STUCK) using the same epic-aware path rule, then run `worktree-merge.js T <blocked|stuck>` followed by `settle-task.js T <blocked|stuck> ...` as in pipeline step c, and drop T from the batch. For `CONTEXT_LIMIT`, respawn a fresh executor **for that T alone** with the handoff protocol from pipeline step c; keep T alive.
   2. **Verifier.** Skip entirely (stub verdict per pipeline step d) when `per_task_verification_enabled` is `false`. Otherwise spawn `shadow-verifier` per T with payload = plan + T's executor report; include `VISUAL_VERIFY: skip` in the prefix alongside `WORKTREE_ROOT:` (PARALLEL MODE implies `EXECUTION_MODE == "parallel"` — see pipeline step d). On return, classify per pipeline step e:
      - `APPROVED` / `APPROVED_WITH_DEFERRED` → keep for phase 3.
      - `NEEDS_CHANGES` → **per-task retry loop** for that T alone: if `executor_loops[T] < executor_retry_max`, increment `executor_loops[T]`, spawn a single executor for T with verifier feedback, then a single verifier for T, and loop. Sibling tasks in the batch do not wait — they have already returned. Use retries as in pipeline step e. On retry-budget exhaustion, write stuck report, run `worktree-merge.js T stuck` + `settle-task.js T stuck ...`, drop from batch.
      - `HUMAN_NEEDED` → append queue entry per pipeline step e, then `worktree-merge.js T abandon` + `settle-task.js T human_needed ...`, drop.
      - `CONTEXT_LIMIT` → respawn verifier for T alone with handoff.
   3. **Code-reviewer.** Skip when `per_task_code_review_enabled` is `false`. Otherwise spawn `code-reviewer` per T. On return, classify per pipeline step f:
      - `CLEAN` → keep for phase 4.
      - `IMPROVEMENTS_NEEDED` → per-task retry for T alone: executor → verifier → code-reviewer, up to `code_review.review_retry_max` rounds. Does not consume `executor_loops`.
      - `SECURITY_ISSUE` → queue entry + `worktree-merge.js T abandon` + `settle-task.js T human_needed ...`, drop.
      - `CONTEXT_LIMIT` → respawn reviewer for T alone with handoff.
   4. **Test-writer.** Spawn `test-writer` per surviving T. Handle per pipeline step f2. Tests run inside each T's worktree (the agent `cd`s to `WORKTREE_ROOT`).

   **4.c — Merge-back + settle** (sequential, from the main worktree). For each T that reached phase 4 alive:
   1. Write T's done report to `.soloflow/archive/done/{EPIC_T}/TASK-NNN-done.md` (or flat if no epic), using the frontmatter schema in pipeline step f3. Write it from the main worktree — done reports live outside the task's code scope.
   2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/worktree-merge.js" T done --base-branch "$RUN_BRANCH"`. Parse the output:
      - `merge: "ff"` or `"non-ff"` → proceed.
      - `merge: "conflict"` → this indicates a `files_owned` mis-declaration (disjoint declarations should never produce a merge conflict). Append a `type: "merge-conflict"` entry to `.soloflow/human-review-queue.md` with `bucket: actions` (resolving the conflict is operational work in the preserved worktree), referencing the preserved worktree path in the script's `error` field, then run `settle-task.js T human_needed --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings/{sprint_id}-findings.md --touched .soloflow/checkpoint.md`. Skip the rest of this task's merge-back; the worktree stays on disk for the human to inspect. Continue with the next T.
   3. On successful merge: `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" T done --done-report <path> --touched .soloflow/active/findings/{sprint_id}-findings.md --touched .soloflow/checkpoint.md`.
   4. Epic archival check per pipeline step f3.

   **4.d — Checkpoint** if the running completed-tasks counter crosses `limits.checkpoint_interval`.

   After step 4, loop back to step 1.

### Per-Task Pipeline (shared by SERIAL and PARALLEL modes)

The following procedure is the per-task quality loop. SERIAL mode (step 3) runs it once for the single batch task, with no `WORKTREE_ROOT` prefix. PARALLEL mode (step 4) runs each lettered phase in one batched Agent call across all alive tasks in the batch, prefixing every prompt with `WORKTREE_ROOT: {WT_T}`. References like "pipeline step c" in PARALLEL MODE point at the lettered substeps below; do not renumber.

For the task (or tasks, in PARALLEL mode):

   Initialize two per-task counters in your working memory: `executor_loops = 0` (incremented every time you re-spawn the executor in step e on `NEEDS_CHANGES`) and `code_review_rounds = 0` (incremented every time you re-spawn the executor in step f on `IMPROVEMENTS_NEEDED`). Both are written into the done-report frontmatter at step f3. CONTEXT_LIMIT respawns and `IMPROVEMENTS_NEEDED` re-verifies do not count toward `executor_loops`.

   a. Set task status to in_progress: `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/update-task-status.js" TASK-{NNN} in_progress`.

   a2. **Locate the plan file** by globbing `.soloflow/active/plans/**/TASK-{NNN}-plan.md` (matches both nested epic folders and flat orphan paths; excludes `EPIC-*.md`). Read the plan's `epic` frontmatter field — it may be a slug or absent/null. This determines where downstream reports go.

   b. Spawn **executor** agent with the plan content. Wait for result.

   c. Handle executor result:
      - **COMPLETED** → proceed to verification.
      - **BLOCKED** → run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} blocked --touched .soloflow/active/findings/{sprint_id}-findings.md --touched .soloflow/checkpoint.md`, continue to next task.
      - **STUCK** → write stuck report to `.soloflow/active/stuck/{epic}/TASK-{NNN}-stuck.md` if the plan has an epic, else flat at `.soloflow/active/stuck/TASK-{NNN}-stuck.md` (create the folder if missing). Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report <that path> --touched .soloflow/active/findings/{sprint_id}-findings.md --touched .soloflow/checkpoint.md`, continue.
      - **CONTEXT_LIMIT** → pass the handoff to a fresh executor. Do NOT run git commands yourself to reconstruct state — keep orchestrator context lean.
        1. Read the `### Handoff` section from the executor's status report (produced by the context monitor protocol).
        2. If context-limit respawns for this agent on this task < resolved `limits.context_limit_respawn_max`, spawn a **fresh executor** with the original plan content prepended with:
           - The previous executor's `### Handoff` section verbatim (if present).
           - If the handoff section is **missing** (agent terminated before reporting): tell the new executor: *"The previous executor hit its context limit without producing a handoff. Before starting work, run `git log --oneline {base_sha}..HEAD -- {files_owned}` and `git status --porcelain` to determine what has already been done. Do NOT redo completed steps or re-commit already-committed changes."*
           - In both cases, include: *"Continue from where the previous executor left off."*
        3. Increment context-limit respawn counter (tracked separately from `executor_retry_max`). If respawn limit reached, escalate as STUCK.

   d. **Verification.** If `per_task_verification_enabled` (Step 0.4) is `false`, skip the verifier spawn entirely. Synthesize a stub verdict: `{ verdict: "APPROVED", visual_mobile: "skipped_user_preference", visual_web: "skipped_user_preference" }` and proceed directly to step f. The NEEDS_CHANGES retry loop and APPROVED_WITH_DEFERRED branch cannot trigger without a verifier. Otherwise (default): spawn the **shadow-verifier** (`subagent_type: "shadow-verifier"`) with plan + executor report and wait for verdict. When `EXECUTION_MODE == "parallel"`, prepend a `VISUAL_VERIFY: skip` line to the shadow-verifier prompt (above the plan payload, alongside any `WORKTREE_ROOT:` directive). The verifier honors the directive by emitting `skipped_user_preference` for both platforms in its Visual Verification block — these values then flow into the done-report frontmatter via the existing copy-verbatim rule in step f3.

   e. Handle verifier verdict (skipped when `per_task_verification_enabled` is `false` — use the stub verdict from step d):
      - **APPROVED** → proceed to code review (step f).
      - **APPROVED_WITH_DEFERRED** → proceed to code review (step f). The deferred checks are already queued in `.soloflow/human-review-queue.md` by the verifier — they will be re-verified in Step 4.
      - **NEEDS_CHANGES** → if `executor_loops < resolved limits.executor_retry_max`, increment `executor_loops` and re-spawn executor with verifier feedback. Otherwise write stuck report.
      - **HUMAN_NEEDED** → append an entry to `.soloflow/human-review-queue.md` using the canonical HUMAN_NEEDED task-entry schema in `commands/quick.md` under "If HUMAN_NEEDED" (fields: `task`, `type`, `plan_ref`, `verdict_notes`, `action`, `severity`). Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} human_needed --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings/{sprint_id}-findings.md --touched .soloflow/checkpoint.md`.
      - **CONTEXT_LIMIT** → read the `### Handoff` section. Spawn a **fresh shadow-verifier** with the original inputs + "Continue verification from previous verifier's handoff: {handoff section}". Same respawn budget as executor CONTEXT_LIMIT handling.

   f. **Code review.** Use `per_task_code_review_enabled` from Step 0.4 (which
      folds the resolved `code_review.enabled` config — fallback `true` — with
      any `--no-code-review` / `--quick` flag override). If `false`, skip this
      entire step — treat the task as CLEAN and go straight to f2. Otherwise:

      Spawn **code-reviewer** with the plan + executor's changed files list. Wait for verdict.
      - **CLEAN** → proceed to step f2 (test writing).
      - **IMPROVEMENTS_NEEDED** → increment `code_review_rounds`, re-spawn executor with review feedback, then re-verify. Does NOT consume the executor retry budget. Loop allowed up to resolved `code_review.review_retry_max` (fallback: 1) rounds. After the cap, accept the remaining findings as minor and proceed to f2.
      - **SECURITY_ISSUE** → escalate to HUMAN_NEEDED. Append an entry to `.soloflow/human-review-queue.md` using the canonical HUMAN_NEEDED task-entry schema in `commands/quick.md` under "If HUMAN_NEEDED" (fields: `task`, `type`, `plan_ref`, `verdict_notes`, `action`, `severity`; populate `verdict_notes` with the code-reviewer's security findings). Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} human_needed --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings/{sprint_id}-findings.md --touched .soloflow/checkpoint.md`.
      - **CONTEXT_LIMIT** → read the `### Handoff` section. Spawn a **fresh code-reviewer** with the original inputs + "Continue review from previous reviewer's handoff: {handoff section}". Same respawn budget.

   f2. **Test writing.** Spawn the **test-writer** agent with the plan, executor's changed files list, and code-reviewer's report. Wait for result.
      - **TESTS_WRITTEN** → run the project's test suite via Bash to confirm no regressions. If the new tests pass, proceed. If they fail, re-spawn the test-writer with the failure output (one retry). If still failing after retry, log a finding and proceed — do not block the task on test issues.
      - **NO_TESTS_NEEDED** → proceed (the test-writer determined nothing warranted new tests).
      - **NO_TEST_INFRA** → proceed (no test framework is set up in this project).
      - **CONTEXT_LIMIT** → read the `### Handoff` section. Spawn a **fresh test-writer** with the original inputs + "Continue from previous test-writer's handoff: {handoff section}". Same respawn budget.

   f3. Write done report to `.soloflow/archive/done/{epic}/TASK-{NNN}-done.md` if the plan has an epic (create the folder if missing), else flat at `.soloflow/archive/done/TASK-{NNN}-done.md`. The report MUST start with this YAML frontmatter (consumed by the sprint-closer and compounder):

       ```
       ---
       id: TASK-{NNN}
       sprint: SPRINT-{NNN}
       epic: {slug or null}
       status: done
       summary: "{one-line summary}"
       executor_loops: {N}        # 0 = verifier passed first try, 1 = one NEEDS_CHANGES retry, etc.
       code_review_rounds: {N}    # 0 = code-reviewer was CLEAN first try, 1 = one IMPROVEMENTS_NEEDED cycle
       visual_mobile: pass | fail | not_applicable | skipped_user_preference | skipped_unable
       visual_web:    pass | fail | not_applicable | skipped_user_preference | skipped_unable
       ---
       ```

       Use the counters you tracked in working memory for this task. Copy `visual_mobile` and `visual_web` verbatim from the verifier's Visual Verification report block (the verifier emits the enum directly — do not re-classify here). If a prior verifier round emitted a different outcome and the task is now passing on a later round, use the *most recent* verifier's values. If `per_task_verification_enabled` (Step 0.4) was `false` for this run, the verifier never ran — write `visual_mobile: skipped_user_preference` and `visual_web: skipped_user_preference` instead. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} done --done-report <that path> --touched .soloflow/active/findings/{sprint_id}-findings.md --touched .soloflow/checkpoint.md` — this removes the task from `sprint.json` and commits `chore(TASK-{NNN}): done`. Then perform the **epic archival check**: if the plan had an epic and no TASK-*.md files remain under `.soloflow/active/plans/{epic}/` and no tasks from that epic remain in `sprint.json`, flag the epic for the Step 4 human review with an "archive this epic?" prompt. On user approval (not automatic), move `.soloflow/active/plans/{epic}/EPIC-{epic}.md` → `.soloflow/archive/done/{epic}/EPIC-{epic}.md` and flip its frontmatter `status` from `active` to `complete`.

   g. Every resolved `limits.checkpoint_interval` completed tasks, write checkpoint to `.soloflow/checkpoint.md`.

   h. **State commit happens inside `settle-task.js`** (invoked by each terminal verdict above). The orchestrator does not run `git add` / `git commit` itself for per-task state.

**End of execute loop.** When step 1's `ready` list is empty, exit Step 3. Sprint status remains `"active"` until the closer's finalize phase flips it. The orchestrator does not write to `sprint.json` here.

## Step 3.5: End-of-sprint verification

If `sprint_verification_enabled` (Step 0.4) is `false`, skip this entire step — do not spawn the shadow-sprint-verifier and do not create `.soloflow/active/sprint-verification.md`. The sprint-closer handles the missing file (tallies sprint-level mobile/web as `not_applicable` with note "sprint-verifier did not run").

Otherwise, spawn the **shadow-sprint-verifier** agent (`subagent_type: "shadow-sprint-verifier"`) with the sprint ID, base SHA (from `sprint.json`'s `run.base_sha` or the commit before sprint start), the list of completed tasks with their plans and changed files, and the resolved visual verification config. Wait for its report.

Handle the report:
- If regressions were found (visual or integration), append each to `.soloflow/human-review-queue.md` via `review-queue.js append --entry-json '{...}'` with the failure details, evidence, and suspected responsible task. Set `bucket: testing` for visual regressions (the user re-runs the flow after fixing) and `bucket: actions` for integration regressions that need operational follow-up (e.g., re-deploy a service).
- Commit via:
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/state/commit-atomic.js" \
      --message "chore(SPRINT-{NNN}): end-of-sprint verification" \
      --path .soloflow/active/sprint-verification.md \
      [--path .soloflow/human-review-queue.md]   # only if regressions were appended
  ```

## Step 3.6: End-of-sprint code review

Use `sprint_code_review_enabled` from Step 0.4 (which folds the resolved
`sprint_code_review.enabled` config — fallback `true` — with any
`--no-code-review` / `--quick` flag override). Resolution is **independent** of
`per_task_code_review_enabled` — you can disable per-task review but keep
sprint-level, or vice versa. If `false`, skip this entire step.

Otherwise, spawn the **sprint-code-reviewer** agent with:

```
Sprint: SPRINT-{NNN}
base_sha: {sha}   # from sprint.json run.base_sha, or the commit before sprint start
completed_tasks:
  - id: TASK-NNN
    epic: {slug or null}
    files_owned: [path, ...]
  - ...
```

Wait for its status report. The agent appends every finding directly to
`.soloflow/active/findings/{sprint_id}-findings.md` (using `findings.js
append`) and writes a counts-only summary to
`.soloflow/active/sprint-code-review.md`. The user is **not** prompted to
triage findings at sprint close — they are queued for the next
`/soloflow:compound` run.

Handle outcomes:
- **REPORTED** → proceed to commit below.
- **CONTEXT_LIMIT** → read the `### Handoff` section. Spawn a **fresh
  sprint-code-reviewer** with the original inputs + "Continue review from
  previous reviewer's handoff: {handoff section}". Same respawn budget as
  other agents (resolved `limits.context_limit_respawn_max`).
- Agent errors or times out → surface a warning and continue. Sprint-level
  code review is advisory — do NOT block sprint close.

**Commit.** Run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/commit-atomic.js" \
    --message "chore(SPRINT-{NNN}): end-of-sprint code review" \
    --path .soloflow/active/sprint-code-review.md \
    --path .soloflow/active/findings/{sprint_id}-findings.md
```

Both files are always written by the reviewer (the summary file even when
zero findings are queued). `commit-atomic.js` skips silently if a path
doesn't exist or nothing was staged.

## Step 3.7: Gather sprint close context

Run the deterministic close-gather script directly (no agent spawn needed — the gather phase is entirely bookkeeping):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sprint/close-gather.js"
```

Parse its JSON output. The payload contains: sprint metadata + run info, task tallies (completed/stuck/human-needed/blocked counts), per-task summaries, parsed `human-review-queue.md` entries (per-bucket counts plus `actions` and `testing` grouped by action; `decisions` and `deferred_visual` listed individually; `other_count` for overridden + malformed), compound-proposal status, findings reconciliation list, and resolved `merge_strategy`.

If the script exits non-zero (e.g., no active sprint), surface stderr as the error and stop.

## Step 4: Human Review

Using the gathered payload, present a consolidated review:
- **Completed tasks** with brief summaries (from `completed_tasks`)
- **Tasks needing human judgment** with notes (from `human_needed_tasks` and the gathered `review_queue.decisions` list)
- **Stuck tasks** with failure details and what was tried (from `stuck_tasks`)
- **Sprint statistics:** `stats.completed_count`, `stats.stuck_count`, `stats.human_needed_count`, `stats.total_executor_loops`, `stats.total_code_review_rounds`
- **Review-queue snapshot.** Print one line summarizing `review_queue.buckets`: `Decisions: {N} · Actions: {N} · Testing: {N} · Deferred Visual: {N}`. Direct the user to `/soloflow:review-queue` for full triage.
- **Code review findings queued.** If `sprint_code_review.ran` is true, print one line: "Code review: {N} findings queued for next `/soloflow:compound`" where `N = sprint_code_review.findings_count.critical + .important + .minor`. If `N == 0`, print "Code review: clean (no findings)." If `sprint_code_review.ran` is false, omit the line.

**Deferred verification — Actions bucket.** If `review_queue.actions` is non-empty, present entries grouped by action, sorted by severity (`high` first, then `medium`, then `low`). For each action, use **AskUserQuestion**: "[{SEVERITY}] Have you completed: {action}?" with options **Yes — re-verify now** / **Not yet — keep deferred** / **No longer needed — dismiss**. (`{SEVERITY}` comes from the gathered `review_queue.actions[].severity` field.)

- **Yes:** Re-spawn the **shadow-verifier** with the original plan + executor report, scoped to only the previously deferred checks. Handle the verdict normally — if it passes, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/review-queue.js" remove --task TASK-NNN --bucket actions` to drop the entry and recompute counts. If it fails, convert to `NEEDS_CHANGES` and present to the user.
- **Not yet:** Leave in the queue. The entry persists for the next session.
- **Dismiss:** Run `review-queue.js remove --task TASK-NNN --bucket actions` to drop the entry and recompute counts.

**Deferred verification — Testing bucket.** If `review_queue.testing` is non-empty, do not re-spawn a verifier here — manual testing belongs in `/soloflow:review-queue` where the visual + manual stage iterator can run. Print one line: `{N} testing items pending — run /soloflow:review-queue --testing-only to walk them.`

Sprint-level code-review findings are **not** triaged here — the
sprint-code-reviewer wrote them straight to the active sprint's findings
file and the next `/soloflow:compound` run will bucket them with full
multi-sprint context (compound-skeptic provides a second pass).

**PAUSE HERE.** The user's job is taste-level review — everything functional has already been verified.

Outside of an active sprint, the same queue can be triaged (with cruft sweep and visual verification) via `/soloflow:review-queue`.

## Step 4.4: Resolve merge choice

If gathered `run` is null (no run branch was created during sprint init), set `merge_choice = "none"` and skip to Step 4.5.

Otherwise use **AskUserQuestion**: "Merge run branch `<run.branch>` into `<run.base_branch>`?" with options:
- **Merge locally** — merge with `merge_strategy`, then delete the branch. → `merge_choice = "merge_locally"`
- **Open PR** — push the branch and open a pull request on GitHub. → `merge_choice = "open_pr"`
- **Keep branch open** — stay on the run branch and let the user merge manually later. → `merge_choice = "keep_open"`
- **Delete without merging** — discard everything in this run (destructive). → re-prompt with **AskUserQuestion** to confirm. On confirm `merge_choice = "delete"`. On cancel fall through to `merge_choice = "keep_open"`.

If `merge_choice = "open_pr"`, prepare:
- `pr_title`: `soloflow: SPRINT-{NNN} ({stats.completed_count} tasks)`
- `pr_body`: render the same content shown in Step 5's report (sprint stats + completed/stuck summaries).

## Step 4.5: Execute sprint close

Spawn the **sprint-closer** agent (phase: finalize) with the resolved decisions:

```
Phase: finalize
Decisions:
  merge_choice: "{merge_locally|open_pr|keep_open|delete|none}"
  pr_title: "{title, only if open_pr}"
  pr_body: "{body, only if open_pr}"
```

Wait for its `COMPLETED` or `ERROR` payload.

Handle the outcome:
- If `ERROR` with `merge_status: conflicts`, print the conflict paths and stop. The user must resolve the conflicts manually before re-invoking `/soloflow:sprint` (which will resume via checkpoint detection in Step 1).
- If `ERROR` for any other reason, surface the error message and stop. Do not retry — the closer has already left state in a known position.
- Otherwise capture `merge.outcome`, `merge.merge_sha` / `merge.pr_url`, and `head_sha` for Step 5.

The closer handles all staging and committing internally — do not run additional `git add` or `git commit` here.

## Step 4.6: Stop sprint-managed dev server

If the closer's gather output contained `dev_server_to_stop`, call **`TaskStop({ task_id: "<task_id>" })`** with the captured task_id. Print `{name} (task_id: {task_id}) stopped at sprint close.`

If gather output did not contain `dev_server_to_stop`, this step is a no-op (the sprint either had `verification.dev_server.enabled: false`, or the user chose `Skip` / `Keep external` at Step 1.5f).

The harness retains the output file in its task store; no SoloFlow-managed cleanup is needed. `sprint.json.dev_server` was never committed (Step 2.5), so it is naturally archived with the rest of `sprint.json` at the closer's finalize step without leaking the now-stale `task_id`.

## Step 5: Report

Render using fields from the closer's finalize output:

```
Sprint SPRINT-{NNN} complete.
- Completed: {stats.completed_count}
- Stuck: {stats.stuck_count}
- Human-needed: {stats.human_needed_count}
- Total executor loops: {stats.total_executor_loops}
- Total code review rounds: {stats.total_code_review_rounds}

Visual coverage:
  Per-task mobile: {per_task.mobile.pass} pass / {per_task.mobile.fail} fail / {per_task.mobile.not_applicable} N/A / {per_task.mobile.skipped_user_preference} skipped (user pref) / {per_task.mobile.skipped_unable} skipped (unable)
  Per-task web:    {per_task.web.pass} pass / {per_task.web.fail} fail / {per_task.web.not_applicable} N/A / {per_task.web.skipped_user_preference} skipped (user pref) / {per_task.web.skipped_unable} skipped (unable)
  Sprint-level:    mobile={sprint_level.mobile}{sprint_level.mobile_note ? " (" + sprint_level.mobile_note + ")" : ""}, web={sprint_level.web}{sprint_level.web_note ? " (" + sprint_level.web_note + ")" : ""}

Run branch: {run.branch or "none — ran on <base_branch>"}
  Status: {merge.outcome rendered as "merged into <base>" | "pr-opened: <url>" | "kept open" | "deleted" | "n/a"}
  Head:   {head_sha}

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

- This command IS the orchestrator for Phase 3. It runs in the main session and spawns executor/shadow-verifier/code-reviewer as leaf-node subagents.
- Config: `executor_retry_max`, `checkpoint_interval`, `max_sprint_tasks`, `context_limit_respawn_max` in `config/defaults.yaml`.
- Branching config: `git.branch_per_run` (runtime-read) in `config/defaults.yaml`, overrideable per-project via `.soloflow/config.json`.

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**:
1. Finish the current subagent interaction (do not abandon a running agent).
2. Write a checkpoint to `.soloflow/checkpoint.md` with the current sprint state, which task is in progress, and what phase of the execute-verify-review loop you are in.

When you receive a **SOLOFLOW CONTEXT CRITICAL**:
1. Finish the current subagent interaction if one is running.
2. Write a detailed checkpoint to `.soloflow/checkpoint.md`.
3. Use **AskUserQuestion** with options:
   - **Compact and continue** — let compaction happen, then resume from checkpoint by re-reading `.soloflow/checkpoint.md` and `.soloflow/active/sprints/{sprint_id}/sprint.json`.
   - **Save and exit** — stop execution. The user can resume later with `/soloflow:sprint` which handles checkpoint resume (Step 1.2).
