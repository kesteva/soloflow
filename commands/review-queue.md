---
description: Triage pending human-review items — resolve state cruft, complete deferred actions, run visual verification, and refine found issues into backlog tasks
argument-hint: "[--skip-cruft | --actions-only | --visual-only]"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:review-queue

Standalone triage for `.soloflow/human-review-queue.md`. Runs outside `/soloflow:executor`'s end-of-sprint flow and can be invoked any time. The interactive phases (cruft → action triage → visual pipeline → issue capture) are fast and decision-only; all time-intensive agent work (re-verification, issue refinement) runs in a single end-of-run batch so you can walk away once the quick decisions are made.

`$ARGUMENTS` optionally includes one flag:
- `--skip-cruft` — skip Step 1 (useful for quick re-invocations after a prior cruft pass).
- `--actions-only` — handle action items only; skip visual + issue phases.
- `--visual-only` — handle visual items only; skip action phase.

If `$ARGUMENTS` is non-empty and not one of the recognized flags, print usage and stop.

---

## Step 0: Initialize

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.
2. If `.soloflow/human-review-queue.md` does not exist, report: "Human review queue file missing. Run `/soloflow:init` to repair state." and stop.
3. `.soloflow/active/sprint.json` may be absent — that's OK. Cruft Scenarios 2 and 4 (which need it) are skipped gracefully.
4. Initialize in-memory counters to 0: `cruft_resolved`, `actions_completed`, `actions_queued_reverify`, `actions_deferred`, `actions_dismissed`, `actions_needs_changes`, `visual_accepted`, `visual_deferred`, `issues_logged`, `issues_queued_refine`, `tasks_created`.
5. Initialize deferred-agent queues (in-memory): `pending_reverifies: []`, `pending_refines: []`. Populated during interactive phases, drained in Step 6.

---

## Step 1: Cruft detection + resolution

Skip this step entirely if `$ARGUMENTS` contains `--skip-cruft`, `--actions-only`, or `--visual-only`.

### 1a. Detect

Run these probes read-only (no prompts yet) and collect results into per-scenario buckets. Use Glob/Grep/Read — do not modify anything.

**Scenario 1 — orphan plan.** For each `.soloflow/active/plans/**/TASK-*-plan.md`, check whether a matching `.soloflow/archive/done/**/TASK-{NNN}-done.md` exists. If yes → plan was never cleaned up after completion. Proposed resolution: delete the plan file.

**Scenario 2 — ghost sprint entry.** Skip if `sprint.json` absent. For each TASK in `sprint.json.tasks` with `status` ∈ {`stuck`, `blocked`, `human_needed`}, check whether neither `.soloflow/active/stuck/**/TASK-{NNN}-stuck.md` nor `.soloflow/active/plans/**/TASK-{NNN}-plan.md` exists. If both missing → ghost. Proposed resolution: prompt per item (synthesize a stub stuck report, or run `settle-task.js TASK-{NNN} blocked` with a note).

**Scenario 3 — stale stuck file.** For each `.soloflow/active/stuck/**/TASK-*-stuck.md`, if TASK is not in `sprint.json` → stale. If a done report exists for that TASK, proposed resolution: move stuck file to `.soloflow/archive/stuck/` (create if needed). Otherwise: prompt (archive or delete).

**Scenario 4 — mid-commit settle crash.** Skip if `sprint.json` absent. For each `.soloflow/archive/done/**/TASK-{NNN}-done.md`, if TASK is still listed in `sprint.json.tasks` → `settle-task.js` crashed between writing the done report and updating sprint.json. Proposed resolution: re-run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} done --done-report <path>` (finalizes the state transition + commits).

**Scenario 5 — empty epic folder.** Glob `.soloflow/active/plans/*/` directories. For each epic dir with zero `TASK-*-plan.md` files AND (if sprint.json exists) no task whose `epic` matches the folder slug → candidate for archival. Proposed resolution: move `EPIC-<slug>.md` → `.soloflow/archive/done/<slug>/EPIC-<slug>.md` and flip its frontmatter `status` field to `complete`.

**Scenario 6 — malformed queue entries.** Read `.soloflow/human-review-queue.md`. Parse each `- task:` body block; collect entries that fail YAML parse or are missing required fields (`task`, `type`). Resolution: surface at end of Step 1 for manual edit.

### 1b. Present + decide

If all six buckets are empty, print `"No cruft detected."` and move on to Step 2.

Otherwise, walk through each non-empty bucket sequentially. For each bucket use **one `AskUserQuestion`** with the full item list **embedded in the question text** (text printed before AskUserQuestion gets cut off by the question UI):

```
Cruft — {scenario name} ({N} items):
  1. TASK-NNN — {short description of the cruft}
  2. TASK-MMM — ...
Resolve?
```

Options (all buckets):
- **Resolve all** — apply the proposed action to every item.
- **Resolve some** — follow-up free-form `AskUserQuestion` for a comma-separated item list (e.g., `1, 3`); unlisted items left alone.
- **Skip bucket** — leave everything as-is.
- **Review each** — loop with one `AskUserQuestion` per item (options: **Resolve** / **Skip**).

For Scenario 6 (malformed entries), print the offending entries verbatim and ask **Edit manually now** / **Skip and continue** — do not try to auto-repair.

### 1c. Apply + commit

Apply resolutions as they are approved:

- **Orphan plan delete (Scenario 1):** `rm <plan-path>`, then `git add <plan-path>` and commit `chore: review-queue — orphan plan: TASK-{NNN}` (one commit per item).
- **Ghost sprint entry (Scenario 2):**
  - If user picks "synthesize stub": write `.soloflow/active/stuck/TASK-{NNN}-stuck.md` with a short frontmatter + body (status: unknown, source: review-queue cruft sweep), then `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} stuck --stuck-report .soloflow/active/stuck/TASK-{NNN}-stuck.md`.
  - If user picks "mark blocked": `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/update-task-status.js" TASK-{NNN} blocked --note "cruft sweep — no plan/stuck file found"`. (This leaves the task in sprint.json with status=blocked.)
- **Stale stuck file (Scenario 3):** `mkdir -p .soloflow/archive/stuck && git mv .soloflow/active/stuck/TASK-{NNN}-stuck.md .soloflow/archive/stuck/` then commit `chore: review-queue — archive stale stuck: TASK-{NNN}`. If user chose delete instead: `rm` + commit.
- **Mid-commit settle crash (Scenario 4):** `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/settle-task.js" TASK-{NNN} done --done-report <done-report-path>` — this self-commits.
- **Empty epic (Scenario 5):** `mkdir -p .soloflow/archive/done/<slug>`, edit `EPIC-<slug>.md`'s frontmatter `status` → `complete`, `git mv .soloflow/active/plans/<slug>/EPIC-<slug>.md .soloflow/archive/done/<slug>/EPIC-<slug>.md`. If the epic folder is now empty, `rmdir` it. Commit `chore: review-queue — archive epic: <slug>`.

Commit rules for the whole step:
- One commit per resolved item (per-item atomicity survives mid-run abort).
- Stage only explicit paths — never `git add .` / `-A`.
- Skip commits silently if the project is not a git repo or `.soloflow/` is gitignored.
- Increment `cruft_resolved` per applied item.

---

## Step 2: Parse + split the queue

Always runs (even with `--skip-cruft`). Skip the split's "action_items" consumption if `--visual-only`; skip the "visual_items" consumption if `--actions-only`.

### 2a. Parse

Read `.soloflow/human-review-queue.md`. Extract the frontmatter (`pending_count`, `items`) and parse the body.

Entry formats present in the queue:

Structured (from `agents/verifier.md`, `commands/executor.md`):
```yaml
- task: TASK-NNN
  type: action_required
  action: "what the human must do"
  blocked_checks:
    - "criterion or verification step blocked"
  level: ground_truth | visual | requirements | goal_backward
  severity: low | medium | high
```

Free-form HUMAN_NEEDED (from `commands/quick.md` step 7, executor HUMAN_NEEDED branch): may lack `blocked_checks`; typically has `notes` + `evidence` + `action` fields.

### 2b. Split

- `visual_items`: `type == action_required` AND `level == visual`.
- `action_items`: `type == action_required` AND `level != visual`, plus HUMAN_NEEDED entries that include a concrete `action`.
- `informational`: any other entry (no actionable remediation). Print a one-line count; do not iterate.
- `malformed`: entries that failed parse — surface as a final note; user edits manually.

### 2c. Short-circuit

If `action_items` and `visual_items` are both empty AND `informational` + `malformed` are the only remnants, print a one-line summary ("No actionable items; {N} informational, {M} malformed.") and proceed to Step 7 (final report). Otherwise continue.

---

## Step 3: Action-item triage

Skip if `--visual-only` or `action_items` is empty.

### 3a. Bulk classification

Sort `action_items` by severity (`high` > `medium` > `low`), then by task ID.

If `len(action_items) > 15`, paginate: split into chunks of 12, process each chunk as its own round of Step 3a/3b before moving on.

Use one `AskUserQuestion` per chunk with the list embedded:

```
{N} action items in queue (sorted by severity):
  1. [HIGH] TASK-007 — Deploy edge function 'token-refresh'
  2. [MED]  TASK-019 — Grant prod DB access to service account
  ...
Triage how?
```

Options:
- **Complete all** — every item enters the completion sub-loop (3b).
- **Complete some** — follow-up free-form `AskUserQuestion` for a comma-separated list (e.g., `1, 3`); unlisted items → `actions_deferred`.
- **Defer all** — no action; proceed to Step 4. Increment `actions_deferred` by `len(action_items)`.
- **Dismiss all** — second `AskUserQuestion` to confirm ("Dismiss {N} items permanently?"). On confirm, remove all entries from the queue; increment `actions_dismissed` accordingly.
- **Triage item-by-item** — descend into a per-item `AskUserQuestion` loop with the same options as 3b (Mark resolved / Queue re-verify / Defer / Dismiss).

### 3b. Per-item completion sub-loop

For each item the user selected for completion, print this instruction block:

```
[{severity}] TASK-NNN — Action {i} of {M}

Action:  {action text}
Level:   {original level}
Blocked checks:
  - {check 1}
  - {check 2}
Plan:    {glob result for .soloflow/active/plans/**/TASK-NNN-plan.md}
```

Then immediately use `AskUserQuestion` (no prose between):

Question: `[{severity}] TASK-NNN: {action}. Done?`

Options:
- **Mark resolved** — remove entry from queue; increment `actions_completed`.
- **Queue re-verify for end-of-run** — tentatively remove entry from queue; append to `pending_reverifies` (see schema below); increment `actions_queued_reverify`. If Step 6's verifier returns NEEDS_CHANGES, entry is restored.
- **Not yet — keep deferred** — leave entry in the queue; increment `actions_deferred`.
- **Dismiss** — remove entry; increment `actions_dismissed`.
- **Abort triage** — stop Step 3 immediately; already-applied resolutions stay applied. Proceed to Step 4.

For HUMAN_NEEDED entries (free-form, no structured `blocked_checks`), omit the "Queue re-verify" option — the verifier has no structured check to re-run against. Offer only Mark resolved / Not yet / Dismiss / Abort.

`pending_reverifies` entry schema:
```yaml
- task: TASK-NNN
  plan_path: .soloflow/active/plans/.../TASK-NNN-plan.md   # or null if missing
  done_report_path: .soloflow/archive/done/.../TASK-NNN-done.md   # or null if missing
  blocked_checks: [...]
  level: ...
  severity: ...
  original_entry: <full entry text, for restore on NEEDS_CHANGES>
```

### 3c. Atomic queue update per decision

After each per-item decision, atomically rewrite `.soloflow/human-review-queue.md`:
1. Write the updated content (remaining items + remaining fields) to `.soloflow/human-review-queue.md.tmp`.
2. `mv` onto `.soloflow/human-review-queue.md`.
3. Recompute `pending_count` = count of remaining entries.

This means mid-phase abort leaves on-disk state consistent.

### 3d. Commit

At end of Step 3: if any changes were made to the queue file, `git add .soloflow/human-review-queue.md` and commit `chore: review-queue — resolved {actions_completed} actions, dismissed {actions_dismissed}, queued {actions_queued_reverify} for re-verify`. Skip if not a git repo or `.soloflow/` gitignored.

---

## Step 4: Visual-verification pipeline

Skip if `--actions-only` or `visual_items` is empty.

### 4a. Bulk accept/defer

Sort `visual_items` by severity then task ID. Paginate at 15 items if needed (same rule as 3a).

One `AskUserQuestion` with list embedded:

```
{N} visual verification items pending:
  1. [HIGH] TASK-011 — Confirm settings toggle persists after app restart
  2. [MED]  TASK-005 — Verify onboarding wizard CTA color
  ...
Accept which for verification now?
```

Options:
- **Accept all** — every item enters the testing plan.
- **Accept some** — follow-up free-form list (e.g., `1, 3`); unlisted items → `visual_deferred`.
- **Defer all** — no action; proceed to Step 5 (skip through if no issues yet). Increment `visual_deferred` by `len(visual_items)`.
- **Dismiss all** — confirm, then remove from queue.
- **Triage item-by-item** — per-item `AskUserQuestion` (Accept / Defer / Dismiss).

If no items are accepted, skip to Step 5.

### 4b. Tool availability (once, before building plan)

1. Resolve visual-verification config:
   - Read `.soloflow/config.json` for `verification.visual_mobile` / `verification.visual_web`.
   - Fall back to `${CLAUDE_PLUGIN_ROOT}/config/defaults.yaml` if not set.
2. For each enabled surface, probe:
   - **Mobile:** `which maestro` via Bash. If found, attempt Maestro MCP `inspect_view_hierarchy` as a probe (mirrors `commands/verify.md` Step 1).
   - **Web:** `which npx` via Bash. If found, attempt a light Playwright MCP navigation probe.
3. Record `{mobile_available: bool, web_available: bool}`.
4. If both are unavailable, **do not abort**. Announce: "Visual MCP tools unavailable — stages will fall back to manual confirmation."

### 4c. Build the testing plan

Build an in-memory list of stages — one stage per accepted visual item. For each stage, determine:

- `surface`: inspect the task's plan (glob `.soloflow/active/plans/**/TASK-NNN-plan.md`) and read `files_owned`. Heuristics:
  - Mobile: paths under `ios/`, `android/`, `app/` with React Native / Expo globs (`*.tsx`, `*.native.*`), or any file under a `.maestro/`-adjacent tree.
  - Web: `pages/`, `src/pages/`, `src/app/`, `public/`, `*.page.tsx`, other web SPA globs.
  - Ambiguous or plan not found → `surface: manual`.
- `maestro_flow`: if `surface == mobile`, grep `maestro/`, `.maestro/`, `test/maestro/` for a flow name that references TASK-NNN, the action text, or the blocked check. Record the path if found.
- `flow`: compact description built from `action` + first `blocked_check`.

### 4d. Present the plan

Render the ordered plan in the question text. Prefixes: `[M]` Maestro, `[M*]` mobile-manual, `[W]` web Playwright, `[W*]` web-manual, `[?]` unknown/manual.

```
Sequential testing plan ({N} stages):
  1. [M]  TASK-011 — settings persistence (flow: login-persistence.yaml)
  2. [M*] TASK-005 — onboarding CTA color (no Maestro flow — manual)
  3. [W]  TASK-018 — inbox empty-state
Start?
```

Options:
- **Start** — begin stage-by-stage iteration (4e).
- **Reorder** — follow-up free-form `AskUserQuestion` for a new order (e.g., `3, 1, 2`). Re-render and re-ask.
- **Drop stages** — follow-up for IDs to drop; dropped stages revert to `visual_deferred`.
- **Cancel** — all accepted stages revert to `visual_deferred`; proceed to Step 5.

### 4e. Stage iteration

For each stage in order:

1. Print the announcement block:
   ```
   Stage {i} of {N} — TASK-NNN [{severity}]

   Flow:    {flow}
   Plan:    {plan_file or "not found"}
   Surface: {mobile | web | manual}
   Blocked checks:
     - {check 1}
   ```
2. Run verification depending on surface + availability:
   - **Mobile + Maestro available:** if `maestro_flow` is set, invoke Maestro MCP `run_flow` on that path; else navigate ad-hoc using `launch_app`, `tap_on`, `input_text`. Prefer `inspect_view_hierarchy` (~50 tokens) over `take_screenshot` (~1600 tokens). Cap screenshots at 3 per stage. **Do not run `maestro test` via Bash while Maestro MCP is active — port 7001 conflict.**
   - **Web + Playwright available:** navigate to the relevant URL; check element presence/content; one screenshot only if appearance is under review.
   - **Manual fallback:** skip programmatic verification. Note in the user prompt: "MCP unavailable — verify manually before choosing verdict."
3. Prompt for verdict via `AskUserQuestion`:
   Question: `Stage {i}/{N} TASK-NNN — {flow}. Verdict?`
   Options:
   - **Pass** — remove the queue entry; increment `visual_accepted`.
   - **Fail — log issue** — descend into 4f.
   - **Skip this stage (defer)** — leave the queue entry; increment `visual_deferred`.
   - **Abort visual run** — stop stage iteration. Remaining stages revert to `visual_deferred`; proceed to Step 5.
4. After each stage, atomically rewrite `.soloflow/human-review-queue.md` (same procedure as 3c) so mid-phase abort leaves disk state consistent.

### 4f. Issue logging sub-flow

On **Fail — log issue**:

1. Use `AskUserQuestion` (free-form): `Describe the issue for TASK-NNN — what you saw vs expected.`
2. Append to in-memory `issues`:
   ```yaml
   - source_task: TASK-NNN
     stage: {i}
     severity: {from stage}
     surface: {mobile | web | manual}
     flow: "{stage flow}"
     description: "{user text}"
     evidence: "{screenshot paths if any, else 'manual observation'}"
     logged_at: "{ISO timestamp}"
   ```
   Increment `issues_logged`.
3. Second `AskUserQuestion`: `What about the original queue entry for TASK-NNN?`
   Options:
   - **Remove original (issue will become its own task)** — default; remove entry from queue.
   - **Keep deferred AND log issue** — the deferred check still stands; leave entry in queue, increment `visual_deferred` as well.

Continue to the next stage.

### 4g. Commit visual pass

After all stages (or abort), if any queue changes occurred, commit `chore: review-queue — visual pass ({visual_accepted} passed, {issues_logged} issues, {visual_deferred} deferred)`. Stage only `.soloflow/human-review-queue.md`.

---

## Step 5: Issue → refinement queue

Skip if `issues` is empty.

### 5a. Confirm

Use `AskUserQuestion` with the list embedded:

```
{N} issues logged during visual verification:
  1. TASK-005 → "Onboarding CTA still blue on Android despite code change"
  2. TASK-018 → "Empty state illustration misaligned on narrow viewports"
  ...
Refine into backlog tasks?
```

Options:
- **Refine all** — every issue queued for batch refinement (Step 6c).
- **Refine some** — follow-up free-form list; unlisted issues discarded (but printed in the final report for manual capture).
- **Review each** — per-issue `AskUserQuestion` (Refine / Skip / Edit description). On Edit, follow-up free-form for new text; then re-present the same decision.
- **Skip all** — discard all logged issues; they are printed in the final report so the user can copy-paste them elsewhere (e.g., into `/soloflow:braindump` later).

### 5b. Queue for batch refinement

For each issue accepted for refinement, append to `pending_refines`:

```yaml
- source_task: TASK-NNN
  severity: ...
  surface: ...
  flow: "..."
  description: "{possibly user-edited}"
  evidence: "..."
```

Increment `issues_queued_refine` per appended item. No files written yet — Step 6c does the work.

---

## Step 6: End-of-run batch — time-intensive agent work

Run only if `pending_reverifies` or `pending_refines` is non-empty.

### 6a. Summary + confirmation

Print:

```
End-of-run batch:
  - Re-verify:  {len(pending_reverifies)} action items
  - Refine:     {len(pending_refines)} visual issues → new TASKs
(Agents may take several minutes; safe to walk away.)
```

`AskUserQuestion`: `Run end-of-run batch?`
Options:
- **Run now** — proceed to 6b then 6c.
- **Run re-verifies only** — 6b only; discard `pending_refines` (but list them in the final report).
- **Run refinement only** — 6c only; restore `pending_reverifies` entries back to `.soloflow/human-review-queue.md` (they were removed tentatively in Step 3b).
- **Skip both** — restore `pending_reverifies` entries; discard `pending_refines`; proceed to Step 7.

When "restoring tentatively removed re-verify entries" is needed: for each `pending_reverifies[*].original_entry`, re-append to the queue body, re-increment `pending_count`, atomic rewrite, and commit `chore: review-queue — restore {N} deferred re-verify entries`.

### 6b. Re-verifications

Iterate `pending_reverifies` sequentially (not in parallel — the verifier is Opus and benefits from fresh context per task).

For each entry:

1. Locate the plan: prefer `pending_reverifies[i].plan_path` if set; otherwise re-glob `.soloflow/active/plans/**/TASK-NNN-plan.md`. If still missing, use the done report as the grounding document (`pending_reverifies[i].done_report_path` or re-glob `.soloflow/archive/done/**/TASK-NNN-done.md`). If neither exists, skip and log a warning in the final report.
2. Spawn the **verifier** agent via the Agent tool. Prompt:

   > "Re-verify TASK-NNN. The deferred check below has been completed by the user; validate **only this check** — do not re-run the full Level 1–5 pipeline.
   >
   > Blocked checks:
   > - {check 1}
   > - {check 2}
   >
   > Plan + prior done report are attached. Return your verdict in the standard format."

   Attach the plan body and the done report body (if present).
3. Handle verdict:
   - **APPROVED** or **APPROVED_WITH_DEFERRED** — entry stays removed from queue (was removed tentatively in 3b); increment `actions_completed`.
   - **NEEDS_CHANGES** — restore `original_entry` to the queue with a new `last_reverify_notes:` field containing the verifier's changes-required list; increment `pending_count`; increment `actions_needs_changes`. In the final report, surface the changes-required list with a hint: *"Use /soloflow:quick to fix."*
   - **HUMAN_NEEDED** — restore `original_entry` to the queue with an updated reason; increment `pending_count`.
   - **CONTEXT_LIMIT** — read the verifier's `### Handoff` section. Respawn a fresh verifier once (budget: 1 respawn per re-verify); if the respawn also returns CONTEXT_LIMIT, restore the entry and note in the final report.
4. Atomic rewrite of `human-review-queue.md` per verdict.

After all re-verifies complete (or are all restored), commit `chore: review-queue — batch re-verify ({actions_completed} approved, {actions_needs_changes} needs-changes)`. Stage only `.soloflow/human-review-queue.md`.

### 6c. Refinements → backlog tasks

Skip if `pending_refines` is empty.

1. Compute the starting TASK ID using the shared bash recipe from the project `CLAUDE.md` (next_id over `.soloflow/active/plans/**/TASK-*-plan.md` ∪ `.soloflow/active/stuck/**/TASK-*-stuck.md` ∪ `.soloflow/archive/done/**/TASK-*-done.md`).
2. Discover existing epics: glob `.soloflow/active/plans/*/EPIC-*.md` (matches `commands/compound.md` and `commands/planner.md`).
3. Assemble a single refinement brief containing a section per `pending_refines` entry:

   ```
   These work items were surfaced by /soloflow:review-queue during the visual pass on {ISO date}. Refine each into an execution-ready task plan.

   ## Item 1
   - Title: {truncated description, ~60 chars}
   - Source task: TASK-{source_task} ({severity}, {surface})
   - Original flow: "{flow}"
   - Problem: {full description}
   - Proposed direction: Investigate root cause in TASK-{source_task}'s owned files; fix without regressing the original flow.
   - Evidence: {evidence}
   - Scope: Bug fix only — do not expand scope.

   ## Item 2
   ...
   ```
4. Spawn the **task-refiner** agent via the Agent tool. Pass:
   - The brief above
   - `starting_task_counter`: `<next id from step 1>`
   - `existing_epics`: `<list from step 2>`
   
   Instruction: *"Produce execution-ready task plans for each item above. Use the starting task counter and collision-safe writes. Orphan tasks (no obvious epic) are acceptable — do not force an epic."*
5. If the task-refiner returns **CONTEXT_LIMIT**: read its `### Handoff`, respawn once with remaining un-refined items plus the partial output.
6. For each plan the task-refiner produced:
   - Write to `.soloflow/active/plans/TASK-{NNN}-plan.md` (respect epic subfolder if the refiner assigned one). Use `wx`/noclobber semantics; if the path exists, recompute the next ID and retry.
   - Add to `.soloflow/active/backlog.json`:
     ```json
     { "id": "TASK-{NNN}", "status": "ready", "depends_on": [], "created": "{ISO}" }
     ```
   - If the refiner created a new `EPIC-<slug>.md`, write that too.
7. Set `tasks_created = <count of new plans>`.
8. Stage only the new plan files + any new `EPIC-*.md` + `.soloflow/active/backlog.json`. Commit `feat: review-queue — plan TASK-{first}..TASK-{last} from visual issues`.

---

## Step 7: Final report

Print:

```
## Review Queue — complete

Cruft resolved            : {cruft_resolved}
Actions completed          : {actions_completed}
Actions needs-changes      : {actions_needs_changes}
Actions deferred           : {actions_deferred}
Actions dismissed          : {actions_dismissed}
Visual stages passed        : {visual_accepted}
Visual stages deferred      : {visual_deferred}
Visual issues logged        : {issues_logged}
New backlog tasks          : {tasks_created} ({TASK-first..TASK-last if any})

Queue status:
  Pending items : {remaining pending_count from human-review-queue.md}
```

If there are discarded issues (Step 5 "Skip all" or Step 6a's "Skip refinement"), append a `Discarded issues:` block listing each one verbatim so the user can copy them into `/soloflow:braindump` or elsewhere.

If there are needs-changes entries (actions_needs_changes > 0), list them with their `last_reverify_notes` and hint:
```
Needs-changes actions:
  - TASK-NNN: {short changes-required summary}
    → /soloflow:quick "<short task description>"
```

End with:
```
Next steps:
  /soloflow:review-queue     — run again to continue triage
  /soloflow:executor         — execute newly planned tasks
  /soloflow:quick             — fix needs-changes items
```

---

## Important notes

- **Never `git add .` or `-A`.** Every commit stages only explicit paths. Matches global atomic-commits policy.
- **Skip commits silently** if the project is not a git repo or `.soloflow/` is gitignored.
- **Atomic queue writes:** every modification to `.soloflow/human-review-queue.md` uses temp-file + rename so abort never leaves half-written content.
- **Maestro port conflict:** never run `maestro test` via Bash while the Maestro MCP server is active — both use port 7001.
- **Re-verify budget:** one respawn per re-verify on CONTEXT_LIMIT; one respawn total for the task-refiner.
- **HUMAN_NEEDED entries** have no structured `blocked_checks`; the "Queue re-verify" option is omitted for them in Step 3b.
- **Pagination:** bulk-classification prompts (Step 3a, 4a) paginate at 15 items / chunks of 12 to stay within AskUserQuestion's text budget.
- If the user passes an unrecognized `$ARGUMENTS`, print usage:
  ```
  /soloflow:review-queue [--skip-cruft | --actions-only | --visual-only]
  ```
  and stop.

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current per-item decision, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction (if one is running in Step 6), write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
