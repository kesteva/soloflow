---
description: Run an execution sprint over ready tasks in the backlog
argument-hint: [optional: TASK-NNN TASK-NNN ... or idea ID to filter]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:sprint

Phase 3 of the SoloFlow pipeline. Creates a sprint from ready tasks in the backlog and runs the executor → verifier → code-reviewer loop until the sprint is complete.

Arguments: **$ARGUMENTS** (optional — specific task IDs to include, or an `IDEA-NNN` to filter; if empty, include all ready tasks up to resolved `limits.max_sprint_tasks`)

---

## Model resolution (applies to every Agent spawn below)

Before invoking the Agent tool for any subagent, resolve `models.<name>` per the
three-tier recipe in [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
(`.soloflow/config.json` → `$CLAUDE_PLUGIN_ROOT/config/defaults.yaml` → inline
fallback matching the agent's frontmatter `model:`). Pass the resolved value as
the Agent tool's `model` parameter. This lets users override model choices via
`/soloflow:config` without editing agent frontmatter.

Mapping used in this command:
- `sprint-initiator` → `models.sprint_initiator` (fallback: `sonnet`)
- `executor` → `models.executor` (fallback: `sonnet`)
- `verifier` → `models.verifier` (fallback: `opus`)
- `code-reviewer` → `models.code_reviewer` (fallback: `opus`)
- `test-writer` → `models.test_writer` (fallback: `sonnet`)
- `sprint-verifier` → `models.sprint_verifier` (fallback: `opus`)
- `sprint-closer` → `models.sprint_closer` (fallback: `sonnet`)

You only need to load the config file once at the start of the run; cache the
resolved values and reuse them for every spawn (including respawns on
`CONTEXT_LIMIT` / `NEEDS_CHANGES` / `IMPROVEMENTS_NEEDED`).

## Limits resolution (applies throughout this command)

Resolve these limits per the recipe in
[docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md) at the start
of the run, then use the resolved values wherever the corresponding concept
appears below (instead of the literal defaults):

- `limits.executor_retry_max` (fallback: 3) — max `NEEDS_CHANGES` re-spawns in step 2.e
- `limits.checkpoint_interval` (fallback: 3) — tasks between checkpoint writes in step 2.g
- `limits.max_sprint_tasks` (fallback: 10) — cap on `$ARGUMENTS`-less sprint scope
- `limits.context_limit_respawn_max` (fallback: 3) — max `CONTEXT_LIMIT` respawns per agent per task

## Sprint Initiation (Steps 0.5–2.8)

Sprint initiation uses the **sprint-initiator** sub-agent in two phases to keep orchestrator context lean. The agent handles file I/O, config resolution, git operations, and test runs; the orchestrator handles all user prompts between phases.

## Step 0.5: Checkpoint & branch resume

These checks happen in the orchestrator before any agent spawn — they may skip initiation entirely.

1. Read `.soloflow/checkpoint.md` — if it indicates an active sprint mid-execution, use **AskUserQuestion** (question: "Sprint {SPRINT-NNN} is in progress. Resume it or start fresh?", options: **Resume** / **Start fresh**). Do not print the choice as prose.
   - If resume: load `sprint.json` and skip directly to Step 3.
   - If fresh: archive the stale sprint and continue.
2. **Run branch resume check:** if `.soloflow/active/sprint.json` exists and contains a `run` object, verify `git rev-parse --abbrev-ref HEAD` matches `run.branch`. If it doesn't match, do NOT silently reattach — use **AskUserQuestion**: **Checkout the run branch** / **Clear the run record and continue on current branch** / **Abort**. Act on the answer before proceeding.

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
```

Parse its structured output. Handle:
- If `status: ERROR` → report the error and stop.
- If `run` is non-null, print: `Run branch: {run.branch} (base: {run.base_branch}@{run.base_sha short})`.

## Step 2.8: Smoke and infra decision

Surface two orthogonal signals from the phase 2 output: the smoke baseline and the task-level infra availability. Present a single **AskUserQuestion** only if at least one of the following is true:
- `smoke_results` is non-null AND (any failures OR `smoke_results.missing_infra` is non-empty)
- `infra_check.missing` is non-empty

Otherwise print `Smoke baseline clean; all required infra available.` and proceed to Step 3 with no prompt.

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

### Options

- **Continue sprint** — proceed to Step 3. If `infra_check.missing` was non-empty, append one line to `.soloflow/active/findings.md` via Bash: `SPRINT-{sprint_id} started with missing infra: {categories}; tests deferred.`
- **Abort** — stop execution so the user can install the missing tooling or fix the baseline, then re-run `/soloflow:sprint`.

This step does NOT fix failures — it only surfaces baseline state and lets the user confirm a known-reduced verification surface.

## Step 3: Execute the Loop

1. **Build dependency graph** from tasks' `depends_on` fields. Tasks with no dependencies are immediately ready.

2. For each ready task (dependencies all completed):

   Initialize two per-task counters in your working memory: `executor_loops = 0` (incremented every time you re-spawn the executor in step 2.e on `NEEDS_CHANGES`) and `code_review_rounds = 0` (incremented every time you re-spawn the executor in step 2.f on `IMPROVEMENTS_NEEDED`). Both are written into the done-report frontmatter at step 2.f3. CONTEXT_LIMIT respawns and `IMPROVEMENTS_NEEDED` re-verifies do not count toward `executor_loops`.

   a. Set task status to in_progress: `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/update-task-status.js" TASK-{NNN} in_progress`.

   a2. **Locate the plan file** by globbing `.soloflow/active/plans/**/TASK-{NNN}-plan.md` (matches both nested epic folders and flat orphan paths; excludes `EPIC-*.md`). Read the plan's `epic` frontmatter field — it may be a slug or absent/null. This determines where downstream reports go.

   b. Spawn **executor** agent with the plan content. Wait for result.

   c. Handle executor result:
      - **COMPLETED** → proceed to verification.
      - **BLOCKED** → run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} blocked --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`, continue to next task.
      - **STUCK** → write stuck report to `.soloflow/active/stuck/{epic}/TASK-{NNN}-stuck.md` if the plan has an epic, else flat at `.soloflow/active/stuck/TASK-{NNN}-stuck.md` (create the folder if missing). Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report <that path> --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`, continue.
      - **CONTEXT_LIMIT** → pass the handoff to a fresh executor. Do NOT run git commands yourself to reconstruct state — keep orchestrator context lean.
        1. Read the `### Handoff` section from the executor's status report (produced by the context monitor protocol).
        2. If context-limit respawns for this agent on this task < resolved `limits.context_limit_respawn_max`, spawn a **fresh executor** with the original plan content prepended with:
           - The previous executor's `### Handoff` section verbatim (if present).
           - If the handoff section is **missing** (agent terminated before reporting): tell the new executor: *"The previous executor hit its context limit without producing a handoff. Before starting work, run `git log --oneline {base_sha}..HEAD -- {files_owned}` and `git status --porcelain` to determine what has already been done. Do NOT redo completed steps or re-commit already-committed changes."*
           - In both cases, include: *"Continue from where the previous executor left off."*
        3. Increment context-limit respawn counter (tracked separately from `executor_retry_max`). If respawn limit reached, escalate as STUCK.

   d. Spawn **verifier** with plan + executor report. Wait for verdict.

   e. Handle verifier verdict:
      - **APPROVED** → proceed to code review (step f).
      - **APPROVED_WITH_DEFERRED** → proceed to code review (step f). The deferred checks are already queued in `.soloflow/human-review-queue.md` by the verifier — they will be re-verified in Step 4.
      - **NEEDS_CHANGES** → if `executor_loops < resolved limits.executor_retry_max`, increment `executor_loops` and re-spawn executor with verifier feedback. Otherwise write stuck report.
      - **HUMAN_NEEDED** → append entry to `.soloflow/human-review-queue.md`, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} human_needed --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`.
      - **CONTEXT_LIMIT** → read the `### Handoff` section. Spawn a **fresh verifier** with the original inputs + "Continue verification from previous verifier's handoff: {handoff section}". Same respawn budget as executor CONTEXT_LIMIT handling.

   f. **Code review.** Resolve `code_review.enabled` per the recipe in
      [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
      (fallback: `true`). If `false`, skip this entire step — treat the task as
      CLEAN and go straight to f2. Otherwise:

      Spawn **code-reviewer** with the plan + executor's changed files list. Wait for verdict.
      - **CLEAN** → proceed to step f2 (test writing).
      - **IMPROVEMENTS_NEEDED** → increment `code_review_rounds`, re-spawn executor with review feedback, then re-verify. Does NOT consume the executor retry budget. Loop allowed up to resolved `code_review.review_retry_max` (fallback: 1) rounds. After the cap, accept the remaining findings as minor and proceed to f2.
      - **SECURITY_ISSUE** → escalate to HUMAN_NEEDED. Append entry to `.soloflow/human-review-queue.md`, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} human_needed --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md`.
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

       Use the counters you tracked in working memory for this task. Copy `visual_mobile` and `visual_web` verbatim from the verifier's Visual Verification report block (the verifier emits the enum directly — do not re-classify here). If a prior verifier round emitted a different outcome and the task is now passing on a later round, use the *most recent* verifier's values. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} done --done-report <that path> --touched .soloflow/active/findings.md --touched .soloflow/checkpoint.md` — this removes the task from `sprint.json` and commits `chore(TASK-{NNN}): done`. Then perform the **epic archival check**: if the plan had an epic and no TASK-*.md files remain under `.soloflow/active/plans/{epic}/` and no tasks from that epic remain in `sprint.json`, flag the epic for the Step 4 human review with an "archive this epic?" prompt. On user approval (not automatic), move `.soloflow/active/plans/{epic}/EPIC-{epic}.md` → `.soloflow/archive/done/{epic}/EPIC-{epic}.md` and flip its frontmatter `status` from `active` to `complete`.

   g. Every resolved `limits.checkpoint_interval` completed tasks, write checkpoint to `.soloflow/checkpoint.md`.

   h. **State commit happens inside `settle-task.js`** (invoked by each terminal verdict above). The orchestrator does not run `git add` / `git commit` itself for per-task state.

3. **End of execute loop.** Sprint status remains `"active"` until the closer's finalize phase flips it. The orchestrator does not write to `sprint.json` here.

## Step 3.5: End-of-sprint verification

Spawn the **sprint-verifier** agent with the sprint ID, base SHA (from `sprint.json`'s `run.base_sha` or the commit before sprint start), the list of completed tasks with their plans and changed files, and the resolved visual verification config. Wait for its report.

Handle the report:
- If regressions were found (visual or integration), add each to `.soloflow/human-review-queue.md` with the failure details, evidence, and suspected responsible task.
- Stage `.soloflow/active/sprint-verification.md` (the sprint-verifier writes it; it's the sprint-closer's single source of truth for sprint-level visual coverage) and commit any `.soloflow/` state changes with `chore(SPRINT-{NNN}): end-of-sprint verification`. Use `git add` with explicit paths — never `git add -A`.

## Step 3.7: Gather sprint close context

Spawn the **sprint-closer** agent (phase: gather) with no additional input. Wait for its `GATHERED` payload.

The payload contains: sprint metadata + run info, task tallies (completed/stuck/human-needed/blocked counts), per-task summaries, parsed `human-review-queue.md` entries (action_required grouped by action, plus other count), compound-proposal status, and resolved `merge_strategy`.

If the agent reports `ERROR` (e.g., no active sprint), surface the error and stop.

## Step 4: Human Review

Using the gathered payload, present a consolidated review:
- **Completed tasks** with brief summaries (from `completed_tasks`)
- **Tasks needing human judgment** with notes (from `human_needed_tasks` and `review_queue.other_summaries`)
- **Stuck tasks** with failure details and what was tried (from `stuck_tasks`)
- **Sprint statistics:** `stats.completed_count`, `stats.stuck_count`, `stats.human_needed_count`, `stats.total_executor_loops`, `stats.total_code_review_rounds`

**Deferred verification.** If `review_queue.action_required` is non-empty, present entries grouped by action, sorted by severity (`high` first, then `medium`, then `low`). For each action, use **AskUserQuestion**: "[{SEVERITY}] Have you completed: {action}?" with options **Yes — re-verify now** / **Not yet — keep deferred** / **No longer needed — dismiss**. (`{SEVERITY}` comes from the gathered `review_queue.action_required[].severity` field.)

- **Yes:** Re-spawn the **verifier** (or **sprint-verifier** for sprint-level flows) with the original plan + executor report, scoped to only the previously deferred checks. Handle the verdict normally — if it passes, edit `.soloflow/human-review-queue.md` to remove the entry and decrement `pending_count`; if it fails, convert to `NEEDS_CHANGES` and present to the user.
- **Not yet:** Leave in the queue. The entry persists for the next session.
- **Dismiss:** Edit the queue to remove the entry and decrement `pending_count`.

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

- This command IS the orchestrator for Phase 3. It runs in the main session and spawns executor/verifier/code-reviewer as leaf-node subagents.
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
   - **Compact and continue** — let compaction happen, then resume from checkpoint by re-reading `.soloflow/checkpoint.md` and `.soloflow/active/sprint.json`.
   - **Save and exit** — stop execution. The user can resume later with `/soloflow:sprint` which handles checkpoint resume (Step 1.2).
