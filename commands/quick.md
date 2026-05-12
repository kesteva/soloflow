---
description: Lightweight bugfix path — skip refinement, go straight to executor + verifier
argument-hint: <description of the bug or fix>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:quick

You are running the SoloFlow quick bugfix workflow. The user has described a bug or small fix. Your job is to create an inline plan, execute it, and verify the result.

The bug description is: **$ARGUMENTS**

## Model + limits resolution

Run once at the start, cache the result:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" --all
```

Keys consumed:
- `models.executor` / `models.test_writer` (fallback: `sonnet`)
- `models.verifier` (fallback: `opus`)
- `limits.executor_retry_max` (fallback: 3) — cap on `NEEDS_CHANGES` retries in Step 7
- `limits.context_limit_respawn_max` (fallback: 3) — cap on `CONTEXT_LIMIT` respawns

Reuse the cached values across all agent spawns and respawns.

## Step 1: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1.5: Investigation-shape check

Before grounding the bug or doing any Grep/Glob work, classify `$ARGUMENTS` as one of:

- **Fix-shape** — the user names a specific file, function, line, value, or describes a mechanical change. Examples: `"fix typo in README line 42"`, `"change FOO_TIMEOUT from 30 to 60 in src/config.ts"`, `"remove unused import in lib/foo.ts"`, `"deps out of date — run npm update"`, `"login is broken because the JWT clock skew exceeds 30s — bump the tolerance to 60s in src/auth/jwt.ts"`. → Proceed to Step 2.
- **Investigation-shape** — the user describes symptoms, error messages, or unexpected behaviors without identifying the root cause or naming a specific change. Examples: `"login button doesn't work on mobile"`, `"API returns 500 sometimes"`, `"tests are flaky"`, `"dropdown closes too early"`, bare `"login is broken"`. → Stop and redirect (see below).
- **Ambiguous** — proceed to Step 2. Bias toward proceeding: false positives (blocking a legitimate `/quick` run) hurt the user more than false negatives (running `/quick` on a bug report; Step 3's "too vague to plan" branch will catch most of those before any executor spawn).

**Only redirect when the input is *clearly* investigation-shape** — i.e., it has multiple symptom signals AND zero specifics (no file path, no function name, no error-stack location, no mechanical-change verb like "rename", "change X to Y", "bump", "remove", "add"). The threshold is conservative on purpose; this is the symmetric counterpart to Step 3's existing "if the bug turns out to be bigger than expected, escalate to `/soloflow:idea-extractor` → `/soloflow:planner` → `/soloflow:sprint`" escape hatch.

If investigation-shape, print this single message and stop without grounding or planning:

```
/quick is the path for fixes you already know. Your description reads as a bug report needing investigation. Run:

  /soloflow:bugfix $ARGUMENTS
```

Do not spawn any agents or run any Grep/Glob work in this case.

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

Write the plan file with `noclobber`/`wx` semantics; if it already exists (a parallel worker raced), recompute the next ID and retry. Then add the task entry to a quick-mode sprint by running:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/update-task-status.js" TASK-{NNN} in_progress --create --plan .soloflow/active/plans/TASK-{NNN}-plan.md
```

`--create` scaffolds a per-sprint `.soloflow/active/sprints/SPRINT-quick-<timestamp>/sprint.json` if no active sprint exists yet, and inserts the task entry.

After `--create` completes, the script's stdout prints `TASK-{NNN}: in_progress (create)` — the active sprint can be discovered via `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/next-ids.js" --kind sprint` (returns the next free ID, not the current one) or by globbing `.soloflow/active/sprints/*/sprint.json` and reading `sprint.id`. Call that value `{sprint_id}` for the rest of the command. Ensure `.soloflow/active/findings/` exists (`mkdir -p`). If `.soloflow/active/findings/{sprint_id}-findings.md` does not already exist, create it with `wx`/`noclobber` semantics:

```
---
sprint: {sprint_id}
pending_count: 0
last_updated: null
---

# Findings Queue
```

All `--touched` flags below reference the per-sprint findings file.

## Step 4: Spawn Executor

Use the Agent tool to spawn the **executor** agent:
- Pass the full content of the plan file as the prompt
- Prefix the plan with: "Implement this task plan. Follow every step. Report your status when done."
- Set `subagent_type` to use the executor agent

Wait for the executor to complete and capture its status report.

## Step 5: Handle Executor Result

Read the executor's status report:

- **If COMPLETED**: Proceed to Step 6 (verification).
- **If BLOCKED**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} blocked --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings/{sprint_id}-findings.md`. Report the blocker to the user. Stop here.
- **If STUCK**: Write a stuck report to `.soloflow/active/stuck/TASK-{NNN}-stuck.md` with the executor's error details. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report .soloflow/active/stuck/TASK-{NNN}-stuck.md --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings/{sprint_id}-findings.md`. Report to the user. Stop here.
- **If CONTEXT_LIMIT**: Read the `### Handoff` section. If context-limit respawns < resolved `limits.context_limit_respawn_max`, spawn a **fresh executor** with the original plan + "Continue from previous executor's handoff: {handoff section}". Otherwise escalate as STUCK.

## Step 6: Spawn Verifier

Use the Agent tool to spawn the **shadow-verifier** agent:
- Pass BOTH the plan file content AND the executor's status report
- Prefix with: "Verify this completed task. The plan and executor report are below. Run all checks independently."
- Set `subagent_type: "shadow-verifier"`

Wait for the verifier's verdict.

## Step 7: Handle Verifier Verdict

Read the verifier's verification report:

### If APPROVED
1. Spawn **test-writer** with the plan, executor's changed files, and "no code-review report" (quick path skips code review). If `TESTS_WRITTEN`, run the test suite to confirm. One retry on failure; if still failing, log a finding and proceed.
2. Write a done report to `.soloflow/archive/done/TASK-{NNN}-done.md` using the verifier's report. Use the frontmatter spec defined in `commands/executor.md` step f3 — populate `executor_loops` from your loop counter, set `code_review_rounds: 0` (quick path skips code review), and copy `visual_mobile` / `visual_web` verbatim from the verifier's Visual Verification report block.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} done --done-report .soloflow/archive/done/TASK-{NNN}-done.md --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings/{sprint_id}-findings.md`. This removes the task from `sprint.json` and commits `chore(TASK-{NNN}): done`.
4. Report success to the user with a summary of changes.

### If NEEDS_CHANGES
Check the loop counter (starts at 1, capped at resolved `limits.executor_retry_max`):
- **If loops < resolved cap**: Go back to Step 4, but append the verifier's feedback to the executor prompt:
  "Previous attempt had issues. The verifier found: {verifier feedback}. Fix these specific issues."
  Increment the loop counter.
- **If loops >= resolved cap**: The task is stuck. Write a stuck report to `.soloflow/active/stuck/TASK-{NNN}-stuck.md` including the verifier's feedback, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report .soloflow/active/stuck/TASK-{NNN}-stuck.md --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/active/findings/{sprint_id}-findings.md`. Report to the user that the fix needs human intervention.

### If HUMAN_NEEDED
1. Append an entry to `.soloflow/human-review-queue.md` using this schema:
   ```
   - task: TASK-{NNN}
     type: HUMAN_NEEDED
     bucket: decisions
     plan_ref: .soloflow/active/plans/[{epic}/]TASK-{NNN}-plan.md
     verdict_notes: "{verifier's HUMAN_NEEDED rationale}"
     action: "{what the human should review or decide}"
     severity: "{low | medium | high}"
   ```
   `plan_ref` is the task's plan path — include `{epic}/` if the plan has an epic, omit otherwise. `bucket: decisions` is fixed for HUMAN_NEEDED entries — they are always judgment calls (UX, copy, scope, security tradeoffs), not operational work or manual verification. This is the canonical HUMAN_NEEDED task-entry schema; other writers (e.g. sprint orchestrator) reference this template.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} human_needed --touched .soloflow/active/plans/TASK-{NNN}-plan.md --touched .soloflow/human-review-queue.md --touched .soloflow/active/findings/{sprint_id}-findings.md`.
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
