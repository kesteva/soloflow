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

## Step 1.8: Check deferred ground-truth items

1. Read `.soloflow/human-review-queue.md`. If the file does not exist or has no entries, skip to Step 2.
2. Parse all entries. Separate into two groups:
   - **Blocking:** entries where `level: ground_truth` and `type: action_required` (skip entries already marked `type: overridden`)
   - **Advisory:** entries where `level` is `visual`, `requirements`, or `goal_backward`
3. If there are **blocking** entries, use **AskUserQuestion**:

   `{N} deferred ground-truth check(s) from prior sprints remain unresolved:`

   List each blocking entry: task ID, action, and blocked checks. Options:
   - **Resolve now** — the user resolves the items before continuing. After they confirm, re-read `human-review-queue.md` and re-check. If blocking items remain, re-prompt.
   - **Override with justification** — the user provides a one-line justification. For each overridden entry, append `override: "{justification}"` and `override_at: {ISO timestamp}`, and flip `type` from `action_required` to `overridden`. Proceed to Step 2.
   - **Abort** — stop execution.

4. If there are **advisory** entries (non-blocking), print a one-line summary: `{N} advisory deferred item(s) from prior sprints (non-blocking).` No prompt — proceed automatically.

## Step 2: Create Sprint

1. **Select tasks:**
   - If `$ARGUMENTS` names specific task IDs, include only those — skip to step 2.
   - If `$ARGUMENTS` names an idea (`IDEA-NNN`), include all ready tasks belonging to that idea — skip to step 2.
   - Otherwise, read `.soloflow/active/backlog.json` and collect all `status: "ready"` tasks. If none, tell the user: "No ready tasks in backlog. Run `/soloflow:planner IDEA-NNN` first." and stop.

   Determine the **natural next epic**: scan the ready tasks' plan files for `epic` frontmatter, find the first epic that has ready tasks (by lowest task ID). Use **AskUserQuestion** with the sprint scope embedded in the question text:

   `{N} ready tasks in backlog. How many to include in this sprint?`

   Options:
   - **Next 5** — include the first 5 ready tasks (by task ID order)
   - **Next 10** — include the first 10 ready tasks
   - **All tasks in {epic name}** — include all ready tasks belonging to the natural next epic *(only show this option if an epic with ready tasks exists; use the epic slug as the name)*
   - **Other** — user specifies task IDs or a count

   If there are fewer than 5 ready tasks, omit "Next 5" and show the actual count instead. If fewer than 10, omit "Next 10".

2. If no tasks were selected, stop.
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

1. `git add .soloflow/active/sprint.json .soloflow/active/backlog.json` — also add `.soloflow/human-review-queue.md` if it was modified by Step 1.8.
2. If `git diff --cached --quiet` reports no staged changes, skip.
3. Otherwise `git commit -m "chore(SPRINT-{NNN}): start sprint"`.

Stage only the listed paths — never `git add .` / `git add -A`. Skip silently if not in a git repo or `.soloflow/` is gitignored. If a run branch was created in Step 2.5, this commit lands on the run branch.

## Step 2.7: Pre-sprint regression smoke (first sprint only)

Skip this step if:
- This sprint was resumed from a checkpoint (Step 1.2 "Resume" path), OR
- Prior sprint archives exist (glob `.soloflow/archive/done/**/TASK-*-done.md` — if any match, a previous sprint already established a passing baseline)

1. **Discover test infrastructure.** Check in order:
   - `package.json` for `test`, `test:unit`, `test:e2e`, `test:integration` scripts
   - Test runner configs: `jest.config.*`, `vitest.config.*`, `.mocharc.*`, `pytest.ini`, `pyproject.toml`
   - Type checker configs: `tsconfig.json`, `mypy.ini`, `pyrightconfig.json`
   - Linter configs: `.eslintrc.*`, `eslint.config.*`, `.flake8`, `ruff.toml`

2. **Run available checks via Bash.** Run the test suite and type checker if found. Capture output. If neither tests nor type checker are found, note this explicitly.

3. **Present results via AskUserQuestion.** Format the question with:
   - Test results: `{N} tests passed, {M} failed` or `No test suite found`
   - Type checker: `Type check passed` / `Type check failed with {N} errors` / `No type checker configured`
   - If any ground-truth infrastructure is missing, note: `Missing: {tests / type checker / linter} — these ground-truth checks are uncovered for this sprint`

   Options:
   - **Continue sprint** — proceed to Step 3.
   - **Abort** — stop execution so the user can investigate failures first.

4. This step does NOT fix failures — it only surfaces the baseline state so the user can make an informed decision.

## Step 3: Execute the Loop

1. **Build dependency graph** from tasks' `depends_on` fields. Tasks with no dependencies are immediately ready.

2. For each ready task (dependencies all completed):

   a. Set task `status: "in_progress"` in `sprint.json`.

   a2. **Locate the plan file** by globbing `.soloflow/active/plans/**/TASK-{NNN}-plan.md` (matches both nested epic folders and flat orphan paths; excludes `EPIC-*.md`). Read the plan's `epic` frontmatter field — it may be a slug or absent/null. This determines where downstream reports go.

   b. Spawn **executor** agent with the plan content. Wait for result.

   c. Handle executor result:
      - **COMPLETED** → proceed to verification.
      - **BLOCKED** → update status to `"blocked"` in `sprint.json`, continue to next task.
      - **STUCK** → write stuck report to `.soloflow/active/stuck/{epic}/TASK-{NNN}-stuck.md` if the plan has an epic, else flat at `.soloflow/active/stuck/TASK-{NNN}-stuck.md`. Create the folder if missing. Update status in `sprint.json`, continue.
      - **CONTEXT_LIMIT** → pass the handoff to a fresh executor. Do NOT run git commands yourself to reconstruct state — keep orchestrator context lean.
        1. Read the `### Handoff` section from the executor's status report (produced by the context monitor protocol).
        2. If context-limit respawns for this agent on this task < `context_limit_respawn_max` (config default: 3), spawn a **fresh executor** with the original plan content prepended with:
           - The previous executor's `### Handoff` section verbatim (if present).
           - If the handoff section is **missing** (agent terminated before reporting): tell the new executor: *"The previous executor hit its context limit without producing a handoff. Before starting work, run `git log --oneline {base_sha}..HEAD -- {files_owned}` and `git status --porcelain` to determine what has already been done. Do NOT redo completed steps or re-commit already-committed changes."*
           - In both cases, include: *"Continue from where the previous executor left off."*
        3. Increment context-limit respawn counter (tracked separately from `executor_retry_max`). If respawn limit reached, escalate as STUCK.

   d. Spawn **verifier** with plan + executor report. Wait for verdict.

   e. Handle verifier verdict:
      - **APPROVED** → proceed to code review (step f).
      - **APPROVED_WITH_DEFERRED** → proceed to code review (step f). The deferred checks are already queued in `.soloflow/human-review-queue.md` by the verifier — they will be re-verified in Step 4.
      - **NEEDS_CHANGES** → if loops < `executor_retry_max` (config default: 3), re-spawn executor with verifier feedback. Otherwise write stuck report.
      - **HUMAN_NEEDED** → add to `.soloflow/human-review-queue.md`, update status in `sprint.json`.
      - **CONTEXT_LIMIT** → read the `### Handoff` section. Spawn a **fresh verifier** with the original inputs + "Continue verification from previous verifier's handoff: {handoff section}". Same respawn budget as executor CONTEXT_LIMIT handling.

   f. Spawn **code-reviewer** with the plan + executor's changed files list. Wait for verdict.
      - **CLEAN** → proceed to step f2 (test writing).
      - **IMPROVEMENTS_NEEDED** (first time only) → re-spawn executor with review feedback, then re-verify. Does NOT consume the executor retry budget.
      - **SECURITY_ISSUE** → escalate to HUMAN_NEEDED. Add to `.soloflow/human-review-queue.md`, update status in `sprint.json`.
      - **CONTEXT_LIMIT** → read the `### Handoff` section. Spawn a **fresh code-reviewer** with the original inputs + "Continue review from previous reviewer's handoff: {handoff section}". Same respawn budget.

   f2. **Test writing.** Spawn the **test-writer** agent with the plan, executor's changed files list, and code-reviewer's report. Wait for result.
      - **TESTS_WRITTEN** → run the project's test suite via Bash to confirm no regressions. If the new tests pass, proceed. If they fail, re-spawn the test-writer with the failure output (one retry). If still failing after retry, log a finding and proceed — do not block the task on test issues.
      - **NO_TESTS_NEEDED** → proceed (the test-writer determined nothing warranted new tests).
      - **NO_TEST_INFRA** → proceed (no test framework is set up in this project).
      - **CONTEXT_LIMIT** → read the `### Handoff` section. Spawn a **fresh test-writer** with the original inputs + "Continue from previous test-writer's handoff: {handoff section}". Same respawn budget.

   f3. Write done report to `.soloflow/archive/done/{epic}/TASK-{NNN}-done.md` if the plan has an epic (create the folder if missing), else flat at `.soloflow/archive/done/TASK-{NNN}-done.md`. Remove task from `sprint.json`. Then perform the **epic archival check**: if the plan had an epic and no TASK-*.md files remain under `.soloflow/active/plans/{epic}/` and no tasks from that epic remain in `sprint.json`, flag the epic for the Step 4 human review with an "archive this epic?" prompt. On user approval (not automatic), move `.soloflow/active/plans/{epic}/EPIC-{epic}.md` → `.soloflow/archive/done/{epic}/EPIC-{epic}.md` and flip its frontmatter `status` from `active` to `complete`.

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

**Deferred verification.** If `human-review-queue.md` contains `type: action_required` entries, present them grouped by action. For each action, use **AskUserQuestion**: "Have you completed: {action}?" with options **Yes — re-verify now** / **Not yet — keep deferred** / **No longer needed — dismiss**.

- **Yes:** Re-spawn the **verifier** (or **sprint-verifier** for sprint-level flows) with the original plan + executor report, scoped to only the previously deferred checks. Handle the verdict normally — if it passes, remove the entry from the queue and decrement `pending_count`; if it fails, convert to `NEEDS_CHANGES` and present to the user.
- **Not yet:** Leave in the queue. The entry persists for the next session.
- **Dismiss:** Remove from the queue and decrement `pending_count`.

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
   - **Merge locally** — merge with `--no-ff`, then delete the branch.
   - **Open PR** — push the branch and open a pull request on GitHub.
   - **Keep branch open** — stay on the run branch and let the user merge manually later.
   - **Delete without merging** — discard everything in this run (destructive).
2. On **Merge locally**:
   - `git checkout <base_branch>`
   - `git merge --no-ff <branch_name> -m "soloflow: merge run <branch_name> (SPRINT-NNN)"` (use the `merge_strategy` value from config if different)
   - If the merge reports conflicts, **do NOT attempt to resolve**. Leave the user on `<base_branch>` with conflict markers in place, print the conflicting paths, and stop. Do not delete the branch.
   - On successful merge, delete the branch: `git branch -d <branch_name>`.
3. On **Open PR**:
   - `git push -u origin <branch_name>`
   - Create a PR with `gh pr create --base <base_branch> --head <branch_name>` using the sprint report from Step 5 as the PR body.
   - Print the PR URL. Do not merge or delete — the user merges via GitHub (branch cleanup happens via GitHub's auto-delete setting or manually).
4. On **Keep branch open**: stay on `<branch_name>`. Print the branch name + base so the user can merge manually later.
5. On **Delete without merging**: re-prompt with `AskUserQuestion` to confirm (destructive action). On confirmation, `git checkout <base_branch>` then `git branch -D <branch_name>`. On cancel, fall through to Keep branch open behavior.

Record the outcome (merged / pr-opened / kept-open / deleted) for Step 5.

## Step 5: Report

```
Sprint SPRINT-{NNN} complete.
- Completed: {count}
- Stuck: {count}
- Human-needed: {count}
- Total executor loops: {count}

Run branch: {branch_name or "none — ran on <base_branch>"}
  Status: {merged into <base> | pr-opened | kept open | deleted | n/a}
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
   - **Save and exit** — stop execution. The user can resume later with `/soloflow:executor` which handles checkpoint resume (Step 1.2).
