---
description: Run an execution sprint over ready tasks in the backlog
argument-hint: [optional: TASK-NNN TASK-NNN ... or idea ID to filter]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:executor

Phase 3 of the SoloFlow pipeline. Creates a sprint from ready tasks in the backlog and runs the executor → verifier → code-reviewer loop until the sprint is complete.

Arguments: **$ARGUMENTS** (optional — specific task IDs to include, or an `IDEA-NNN` to filter; if empty, include all ready tasks up to `max_sprint_tasks`)

---

## Config resolution — `git.branch_per_run`

This command reads the branching preference at runtime. Resolve in this order (first hit wins):

1. **Project override:** if `.soloflow/config.json` exists and contains `git.branch_per_run`, use it.
2. **Plugin default:** read `${CLAUDE_PLUGIN_ROOT}/config/defaults.yaml` (via `echo $CLAUDE_PLUGIN_ROOT` in Bash) and grep for `branch_per_run:` under the `git:` block.
3. **Fallback:** `prompt` if neither file has the key.

Valid values: `always` (create run branch silently), `never` (stay on current branch), `prompt` (ask the user at Step 1.5).

---

## Step 1: Initialize

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.
2. Read `.soloflow/checkpoint.md` — if it indicates an active sprint mid-execution, use the **AskUserQuestion** tool (question: "Sprint {SPRINT-NNN} is in progress. Resume it or start fresh?", options: **Resume** / **Start fresh**). Do not print the choice as prose.
   - If resume: load `sprint.json` and continue the execution loop below.
   - If fresh: archive the stale sprint and continue.
3. **Run branch resume check:** if `sprint.json` contains a `run` object (set by Step 2.5 on a previous invocation), verify `git rev-parse --abbrev-ref HEAD` matches `run.branch`. If it doesn't match, do NOT silently reattach — use `AskUserQuestion` to ask the user: **Checkout the run branch** / **Clear the run record and continue on current branch** / **Abort**. Act on the answer before proceeding.
4. Read `.soloflow/active/backlog.json`.

## Step 1.5: Resolve branching preference

1. Resolve `git.branch_per_run` per the config resolution rule above.
2. If the value is `always` → set `create_branch = true`, skip the prompt.
3. If the value is `never` → set `create_branch = false`, skip the prompt.
4. If the value is `prompt` → use **AskUserQuestion** with:
   - "Create a run branch (recommended)" — isolates this run so `main` stays clean until human review.
   - "Stay on current branch" — commits land on the current branch directly.
   - "Create a run branch and remember this choice" — same as option 1, plus write `{"git":{"branch_per_run":"always"}}` to `.soloflow/config.json` (merging with any existing content).
5. **Guardrails (applied after `create_branch` is set):**
   - If `create_branch = true` and `git status --porcelain` is non-empty, stop and tell the user to commit or stash their working tree before starting a run.
   - If `create_branch = false`, current branch is `main` or `master`, and the sprint-to-be has more than one task, warn the user and re-prompt — they can still explicitly choose "Stay on current branch" to override.

## Step 2: Create Sprint

1. Select tasks:
   - If `$ARGUMENTS` names specific task IDs, include only those.
   - If `$ARGUMENTS` names an idea (`IDEA-NNN`), include all ready tasks belonging to that idea.
   - Otherwise, include all `status: "ready"` tasks up to `max_sprint_tasks` (config default: 10).
2. If no tasks match, tell the user: "No ready tasks in backlog. Run `/soloflow:planner IDEA-NNN` first." and stop.
3. Compute the next sprint ID by globbing every location a sprint artifact lands — `.soloflow/archive/compound/SPRINT-*-proposal.md`, `.soloflow/archive/findings/SPRINT-*-findings.md` — plus the current `sprint.json`'s `sprint.id` if populated. Take the max numeric suffix + 1, zero-padded to 3 digits. See the "ID allocation" section in the project `CLAUDE.md` for the shared recipe.
4. Create `.soloflow/active/sprint.json` with:
   - `sprint.id: "SPRINT-{NNN}"`, `sprint.status: "active"`, `sprint.started: {ISO timestamp}`
   - Selected tasks moved from `backlog.json` into `sprint.json`

## Step 2.5: Create run branch (only if `create_branch` is true)

1. Capture base state via Bash:
   - `base_branch=$(git rev-parse --abbrev-ref HEAD)`
   - `base_sha=$(git rev-parse HEAD)`
2. Generate the branch name from the `branch_name_format` config value:
   - `{timestamp}` → `date +%Y%m%d-%H%M%S`
   - `{sprint_id}` → the sprint ID created in Step 2 (e.g. `SPRINT-007`)
3. `git checkout -b <branch_name>`.
4. Write a `run` object into `.soloflow/active/sprint.json`:
   ```json
   "run": {
     "branch": "soloflow/run-20260409-142200-SPRINT-007",
     "base_branch": "main",
     "base_sha": "abc123…",
     "created_at": "2026-04-09T14:22:00Z"
   }
   ```
5. Print a single line: `Run branch: <branch_name> (base: <base_branch>@<short_sha>)`.

If any git command fails, stop and report the failure — do NOT silently fall back to the current branch.

## Step 2.6: Commit sprint start

Commit the newly written sprint state before entering the execution loop.

1. `git add .soloflow/active/sprint.json .soloflow/active/backlog.json`
2. If `git diff --cached --quiet` reports no staged changes, skip.
3. Otherwise `git commit -m "chore(SPRINT-{NNN}): start sprint"`.

Stage only the listed paths — never `git add .` / `git add -A`. Skip silently if not in a git repo or `.soloflow/` is gitignored. If a run branch was created in Step 2.5, this commit lands on the run branch.

## Step 3: Execute the Loop

1. **Build dependency graph** from tasks' `depends_on` fields. Tasks with no dependencies are immediately ready.

2. For each ready task (dependencies all completed):

   a. Set task `status: "in_progress"` in `sprint.json`.

   a2. **Locate the plan file** by globbing `.soloflow/active/plans/**/TASK-{NNN}-plan.md` (matches both nested epic folders and flat orphan paths; excludes `EPIC.md`). Read the plan's `epic` frontmatter field — it may be a slug or absent/null. This determines where downstream reports go.

   b. Spawn **executor** agent with the plan content. Wait for result.

   c. Handle executor result:
      - **COMPLETED** → proceed to verification.
      - **BLOCKED** → update status to `"blocked"` in `sprint.json`, continue to next task.
      - **STUCK** → write stuck report to `.soloflow/active/stuck/{epic}/TASK-{NNN}-stuck.md` if the plan has an epic, else flat at `.soloflow/active/stuck/TASK-{NNN}-stuck.md`. Create the folder if missing. Update status in `sprint.json`, continue.

   d. Spawn **verifier** with plan + executor report. Wait for verdict.

   e. Handle verifier verdict:
      - **APPROVED** → proceed to code review (step f).
      - **NEEDS_CHANGES** → if loops < `executor_retry_max` (config default: 3), re-spawn executor with verifier feedback. Otherwise write stuck report.
      - **HUMAN_NEEDED** → add to `.soloflow/human-review-queue.md`, update status in `sprint.json`.

   f. Spawn **code-reviewer** with the plan + executor's changed files list. Wait for verdict.
      - **CLEAN** → proceed to step f2 (test writing).
      - **IMPROVEMENTS_NEEDED** (first time only) → re-spawn executor with review feedback, then re-verify. Does NOT consume the executor retry budget.
      - **SECURITY_ISSUE** → escalate to HUMAN_NEEDED. Add to `.soloflow/human-review-queue.md`, update status in `sprint.json`.

   f2. **Test writing.** Spawn the **test-writer** agent with the plan, executor's changed files list, and code-reviewer's report. Wait for result.
      - **TESTS_WRITTEN** → run the project's test suite via Bash to confirm no regressions. If the new tests pass, proceed. If they fail, re-spawn the test-writer with the failure output (one retry). If still failing after retry, log a finding and proceed — do not block the task on test issues.
      - **NO_TESTS_NEEDED** → proceed (the test-writer determined nothing warranted new tests).
      - **NO_TEST_INFRA** → proceed (no test framework is set up in this project).

   f3. Write done report to `.soloflow/archive/done/{epic}/TASK-{NNN}-done.md` if the plan has an epic (create the folder if missing), else flat at `.soloflow/archive/done/TASK-{NNN}-done.md`. Remove task from `sprint.json`. Then perform the **epic archival check**: if the plan had an epic and no TASK-*.md files remain under `.soloflow/active/plans/{epic}/` and no tasks from that epic remain in `sprint.json`, flag the epic for the Step 4 human review with an "archive this epic?" prompt. On user approval (not automatic), move `.soloflow/active/plans/{epic}/EPIC.md` → `.soloflow/archive/done/{epic}/EPIC.md` and flip its frontmatter `status` from `active` to `complete`.

   g. Every `checkpoint_interval` completed tasks (config default: 3), write checkpoint to `.soloflow/checkpoint.md`.

   h. **Commit state for this task.** After the task has fully settled (done, stuck, blocked, or human-needed) and all state files for it have been written, commit the `.soloflow/` state changes via Bash. This is a **state-only** commit and is separate from any code commits the executor subagent made.
      - `git add` only the specific state paths that changed for this task: `.soloflow/active/sprint.json`, the new done report (`.soloflow/archive/done/**/TASK-{NNN}-done.md`) or stuck report (`.soloflow/active/stuck/**/TASK-{NNN}-stuck.md`), `.soloflow/active/findings.md` if it was appended to during this task, `.soloflow/human-review-queue.md` if it was updated, and `.soloflow/checkpoint.md` if Step 3.g wrote one.
      - Never `git add .` / `git add -A`.
      - If `git diff --cached --quiet` reports no staged changes, skip.
      - Otherwise commit with a verdict-scoped message: `chore(TASK-{NNN}): done` / `chore(TASK-{NNN}): stuck` / `chore(TASK-{NNN}): blocked` / `chore(TASK-{NNN}): human-needed`.
      - Skip silently if not in a git repo or `.soloflow/` is gitignored.

3. **Complete sprint** — set `sprint.status: "complete"` in `sprint.json`.

## Step 3.5: End-of-sprint verification

Spawn the **sprint-verifier** agent with the sprint ID, base SHA (from `sprint.json`'s `run.base_sha` or the commit before sprint start), the list of completed tasks with their plans and changed files, and the resolved visual verification config. Wait for its report.

Handle the report:
- If regressions were found (visual or integration), add each to `.soloflow/human-review-queue.md` with the failure details, evidence, and suspected responsible task.
- Commit any `.soloflow/` state changes with `chore(SPRINT-{NNN}): end-of-sprint verification`.

## Step 4: Human Review

Read `.soloflow/human-review-queue.md` and all stuck reports from `.soloflow/active/stuck/`.

Present a consolidated review:
- **Completed tasks** with brief summaries
- **Tasks needing human judgment** (HUMAN_NEEDED verdicts) with verifier notes
- **Stuck tasks** with failure details and what was tried
- **Sprint statistics:** completed, stuck, human-needed, total executor loops

**PAUSE HERE.** The user's job is taste-level review — everything functional has already been verified.

## Step 4.4: Commit sprint close

Commit the sprint-closing state (sprint.json marked complete plus any final queue/checkpoint updates) before the run-branch merge decision.

1. **Archive stale compound proposal.** If `.soloflow/active/COMPOUND-PROPOSAL.md` exists:
   a. Read its YAML frontmatter to extract the `sprint:` field (e.g., `SPRINT-005`).
   b. Move it to `.soloflow/archive/compound/{sprint}-proposal.md`.
   c. If the destination already exists (already archived by a prior compound run), skip — do not overwrite.
   d. If the frontmatter lacks a `sprint:` field, skip with a warning.
   e. Include the moved file in the `git add` below.
2. `git add .soloflow/active/sprint.json .soloflow/human-review-queue.md .soloflow/checkpoint.md` — also add `.soloflow/archive/compound/{sprint}-proposal.md` if step 1 moved a file (include only the paths that actually changed).
3. If `git diff --cached --quiet` reports no staged changes, skip.
4. Otherwise `git commit -m "chore(SPRINT-{NNN}): close sprint"`.

Never `git add .` / `git add -A`. Skip silently if not in a git repo or `.soloflow/` is gitignored.

## Step 4.5: Merge run branch (only if Step 2.5 created one)

1. Use **AskUserQuestion** to ask: "Merge run branch `<branch_name>` into `<base_branch>`?" with options:
   - **Merge** — merge with `--no-ff` and leave the branch in place for inspection.
   - **Keep branch open** — stay on the run branch and let the user merge manually later.
   - **Delete without merging** — discard everything in this run (destructive).
2. On **Merge**:
   - `git checkout <base_branch>`
   - `git merge --no-ff <branch_name> -m "soloflow: merge run <branch_name> (SPRINT-NNN)"` (use the `merge_strategy` value from config if different)
   - If the merge reports conflicts, **do NOT attempt to resolve**. Leave the user on `<base_branch>` with conflict markers in place, print the conflicting paths, and stop the command.
   - Do not delete the run branch automatically — the user may want to cherry-pick or inspect.
3. On **Keep branch open**: stay on `<branch_name>`. Print the branch name + base so the user can merge manually later.
4. On **Delete without merging**: re-prompt with `AskUserQuestion` to confirm (destructive action). On confirmation, `git checkout <base_branch>` then `git branch -D <branch_name>`. On cancel, fall through to Keep branch open behavior.

Record the outcome (merged / kept-open / deleted) for Step 5.

## Step 5: Report

```
Sprint SPRINT-{NNN} complete.
- Completed: {count}
- Stuck: {count}
- Human-needed: {count}
- Total executor loops: {count}

Run branch: {branch_name or "none — ran on <base_branch>"}
  Status: {merged into <base> | kept open | deleted | n/a}
  Head:   {short SHA at end of run}

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
- Branching config: `git.branch_per_run` (runtime-read) in `config/defaults.yaml`, overrideable per-project via `.soloflow/config.json`.
