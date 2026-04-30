---
description: Triage pending human-review items — resolve cruft, walk Decisions/Actions/Testing/Deferred Visual buckets, refine found issues into backlog tasks
argument-hint: "[--skip-cruft | --decisions-only | --actions-only | --testing-only | --deferred-visual-only]"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion, mcp__maestro__*, mcp__playwright__*]
---

# /soloflow:review-queue

Standalone triage for `.soloflow/human-review-queue.md`. Runs outside `/soloflow:sprint`'s end-of-sprint flow and can be invoked any time. The interactive phases (cruft → decisions → actions → testing → deferred visual) are fast and decision-only; all time-intensive agent work (re-verification, issue refinement) runs in a single end-of-run batch so you can walk away once the quick decisions are made.

`$ARGUMENTS` optionally includes one bucket-scope flag:

- `--skip-cruft` — skip Step 1 (useful for quick re-invocations after a prior cruft pass).
- `--decisions-only` — handle the Decisions bucket only.
- `--actions-only` — handle the Actions bucket only.
- `--testing-only` — handle the Testing bucket only (visual + non-visual manual verification).
- `--deferred-visual-only` — handle only the Deferred Visual bucket (visual failures the user previously chose to defer).

If `$ARGUMENTS` is non-empty and not one of the recognized flags, print usage and stop.

The bucket model:

- **Decisions** — judgment calls (UX/copy/scope/security tradeoffs). The human reads context and picks. No re-verification path.
- **Actions** — operational work the human performs on systems (deploy, configure, set env vars, run migrations, resolve merge conflicts, install tooling). After completion, the verifier can re-run the previously-blocked check.
- **Testing** — verification only a human can do (visual checks, manual flows, ground-truth checks like "hit /api/foo and confirm 200"). The human's confirmation IS the verification — no agent re-verifies.
- **Deferred Visual** — visual verification failures the user explicitly chose to defer in a previous run; holding area before promoting to a backlog TASK or re-testing.

---

## Model resolution (applies to every Agent spawn below)

Before invoking the Agent tool, resolve `models.<name>` per the three-tier
recipe in [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
and pass the resolved value as the Agent tool's `model` parameter.

Mapping used in this command:
- `shadow-verifier` → `models.verifier` (fallback: `opus`)
- `task-refiner` → `models.task_refiner` (fallback: `opus`)

## Step 0: Initialize

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.
2. If `.soloflow/human-review-queue.md` does not exist, report: "Human review queue file missing. Run `/soloflow:init` to repair state." and stop.
3. `.soloflow/active/sprint.json` may be absent — that's OK. Cruft Scenarios 2 and 4 (which need it) are skipped gracefully.
4. Initialize in-memory counters to 0:
   - `cruft_resolved`
   - `decisions_resolved`, `decisions_deferred`, `decisions_dismissed`
   - `actions_completed`, `actions_queued_reverify`, `actions_deferred`, `actions_dismissed`, `actions_needs_changes`
   - `testing_passed`, `testing_failed_promoted`, `testing_failed_deferred`, `testing_deferred`, `testing_dismissed`
   - `deferred_visual_promoted`, `deferred_visual_retested_pass`, `deferred_visual_retested_fail`, `deferred_visual_dismissed`
   - `tasks_created`, `legacy_sprint_code_review_seen`
5. Initialize deferred-agent queues (in-memory): `pending_reverifies: []`, `pending_refines: []`. Populated during interactive phases, drained in Step 7.

---

## Step 1: Cruft detection + resolution

Skip this step entirely if `$ARGUMENTS` contains `--skip-cruft` or any of the bucket-scope flags.

Read `docs/CRUFT-CLEANUP.md` via the Read tool and follow its procedure to completion. Use `review-queue` as the commit-message `<command>` label. The procedure updates the `cruft_resolved` counter initialized in Step 0.

For the same cruft sweep without the rest of this command's triage, see `/soloflow:housekeeping`.

---

## Step 2: Parse the queue

Always runs (even with `--skip-cruft`). Bucket-scope flags only narrow which Steps 3–6 fire below; parsing always reads the whole queue.

### 2a. Parse

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/review-queue.js" gather --group-by action
```

The script returns JSON `{ entries, decisions, actions, testing, deferred_visual, overridden, malformed, pending_count, buckets, action_required_grouped }`. The `action_required_grouped` field groups the `actions` + `testing` buckets by `action` text (max severity preserved); use it for the bulk-classification prompts in Steps 4 and 5.

**Legacy entries.** Older versions of this codebase wrote `type: sprint_code_review` entries into the queue. The current sprint-code-reviewer no longer does — findings land directly in `.soloflow/active/findings/{sprint_id}-findings.md` for the compounder. Any pre-existing `sprint_code_review` entries in the queue still parse; they appear in whichever bucket `classifyBucket()` infers (typically `decisions` since `type` is unknown). Set `legacy_sprint_code_review_seen` to the count of such entries so Step 8 can surface the cleanup hint.

Entry shapes by bucket:

**Decisions** (HUMAN_NEEDED, investigation_inconclusive):
```yaml
- task: TASK-NNN              # may be null for investigation_inconclusive
  type: HUMAN_NEEDED
  bucket: decisions
  plan_ref: ".soloflow/active/plans/[{epic}/]TASK-NNN-plan.md"
  verdict_notes: "..."
  action: "what the human should review or decide"
  severity: low | medium | high
```

**Actions** (action_required operational, config_issue, merge-conflict):
```yaml
- task: TASK-NNN
  type: action_required
  bucket: actions
  action: "what the human must do"
  blocked_checks: ["criterion blocked"]
  level: ground_truth | requirements | goal_backward
  severity: low | medium | high
```

**Testing** (action_required where the human verifies; always when level==visual):
```yaml
- task: TASK-NNN
  type: action_required
  bucket: testing
  action: "verify X / open Y in Safari / run Maestro flow Z"
  blocked_checks: ["criterion blocked"]
  level: visual | ground_truth | requirements | goal_backward
  severity: low | medium | high
```

**Deferred Visual** (visual_failure, populated by Step 5 below):
```yaml
- task: TASK-NNN
  type: visual_failure
  bucket: deferred_visual
  source_task: TASK-NNN          # task that failed visual verification
  flow: "settings persistence"
  description: "what the user observed"
  evidence: "screenshot path or 'manual observation'"
  severity: low | medium | high
  logged_at: "ISO timestamp"
```

### 2b. Short-circuit

If every bucket array is empty AND `malformed` is empty, print a one-line summary (`No actionable items in queue.`) and proceed to Step 8 (final report). Otherwise continue.

---

## Step 3: Decisions triage

Skip if any of the following is true: `$ARGUMENTS` contains `--actions-only`, `--testing-only`, or `--deferred-visual-only`; or `decisions` is empty.

### 3a. Bulk overview

Sort `decisions` by severity (`high` > `medium` > `low`), then by task ID. Paginate at 15 items if needed (chunks of 12).

One `AskUserQuestion` with the list embedded:

```
{N} decisions pending (judgment calls):
  1. [HIGH] TASK-007 — review proposed copy for onboarding screen
  2. [MED]  TASK-019 — pick auth flow: SSO vs magic link
  ...
Triage how?
```

Options:
- **Resolve all** — every item enters the per-item resolution loop (3b).
- **Triage item-by-item** — descend into 3b for each item.
- **Defer all** — leave entries in queue; increment `decisions_deferred` by count. Skip to Step 4.
- **Dismiss all** — confirm via second AskUserQuestion, then remove all entries.

### 3b. Per-item resolution

For each decision, print the context block, then ask via `AskUserQuestion`:

```
[{severity}] TASK-NNN — Decision {i} of {M}

Action:        {action text}
Verdict notes: {verdict_notes if present}
Plan:          {glob result for .soloflow/active/plans/**/TASK-NNN-plan.md}
```

Question: `[{severity}] TASK-NNN: {action}. Decision?`

Options:
- **Resolved** — remove entry from queue; increment `decisions_resolved`. Decisions don't queue re-verify — once the human picks a direction, the next sprint or quick run consumes it.
- **Defer** — leave in queue; increment `decisions_deferred`.
- **Dismiss** — remove entry; increment `decisions_dismissed`.
- **Abort triage** — stop Step 3; already-applied resolutions stay applied.

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/review-queue.js" remove --task TASK-NNN --bucket decisions` after each Resolved/Dismiss decision.

### 3c. Commit

At end of Step 3, if any changes were made:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/commit-atomic.js" \
    --message "chore: review-queue — resolved {decisions_resolved} decisions, dismissed {decisions_dismissed}" \
    --path .soloflow/human-review-queue.md
```

---

## Step 4: Actions triage

Skip if any of: `--decisions-only`, `--testing-only`, `--deferred-visual-only`, or `actions` is empty.

### 4a. Bulk classification

Sort `actions` by severity then task ID. Paginate at 15 (chunks of 12).

`AskUserQuestion` with list:

```
{N} actions pending (operational work):
  1. [HIGH] TASK-007 — Deploy edge function 'token-refresh'
  2. [MED]  TASK-019 — Grant prod DB access to service account
  ...
Triage how?
```

Options:
- **Complete all** — every item enters the completion sub-loop (4b).
- **Complete some** — follow-up free-form list (e.g., `1, 3`); unlisted → `actions_deferred`.
- **Defer all** — increment `actions_deferred` by count, proceed to Step 5.
- **Dismiss all** — confirm, then remove all entries; increment `actions_dismissed`.
- **Triage item-by-item** — descend into 4b per item.

### 4b. Per-item completion sub-loop

For each item the user selected for completion, print:

```
[{severity}] TASK-NNN — Action {i} of {M}

Action:         {action text}
Level:          {level}
Blocked checks:
  - {check 1}
Plan:           {plan glob result}
```

`AskUserQuestion`: `[{severity}] TASK-NNN: {action}. Done?`

Options:
- **Mark resolved** — remove entry; increment `actions_completed`.
- **Queue re-verify for end-of-run** — tentatively remove; append to `pending_reverifies` (schema below); increment `actions_queued_reverify`. If Step 7's verifier returns NEEDS_CHANGES, entry is restored.
- **Not yet — keep deferred** — leave in queue; increment `actions_deferred`.
- **Dismiss** — remove; increment `actions_dismissed`.
- **Abort triage** — stop Step 4; already-applied resolutions stay applied.

`pending_reverifies` entry schema:
```yaml
- task: TASK-NNN
  plan_path: .soloflow/active/plans/.../TASK-NNN-plan.md   # or null
  done_report_path: .soloflow/archive/done/.../TASK-NNN-done.md   # or null
  blocked_checks: [...]
  level: ...
  severity: ...
  bucket: actions
  original_entry: <full entry text, for restore on NEEDS_CHANGES>
```

After each per-item decision, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/review-queue.js" remove --task TASK-NNN --bucket actions` (or no-op for "Not yet").

### 4c. Commit

At end of Step 4, if any changes were made:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/commit-atomic.js" \
    --message "chore: review-queue — completed {actions_completed} actions, dismissed {actions_dismissed}, queued {actions_queued_reverify} for re-verify" \
    --path .soloflow/human-review-queue.md
```

---

## Step 5: Testing pipeline

Skip if any of: `--decisions-only`, `--actions-only`, `--deferred-visual-only`, or `testing` is empty.

The Testing bucket holds *all* human verification work — visual flows (Maestro / Playwright) AND non-visual manual checks ("curl /api/foo and confirm 200", "open the page in Safari and confirm copy"). Both are handled here.

### 5a. Bulk accept/defer

Sort `testing` by severity then task ID. Paginate at 15 (chunks of 12).

```
{N} testing items pending (human verification):
  1. [HIGH] TASK-011 — verify settings toggle persists after app restart  [visual]
  2. [MED]  TASK-005 — confirm onboarding wizard CTA color                [visual]
  3. [LOW]  TASK-018 — curl /api/health and confirm 200                   [non-visual]
  ...
Run which now?
```

Options:
- **Run all** — every item enters the testing plan.
- **Run some** — follow-up free-form list; unlisted → `testing_deferred`.
- **Defer all** — increment `testing_deferred` by count; proceed to Step 6.
- **Dismiss all** — confirm, then remove all entries.
- **Triage item-by-item** — per-item AskUserQuestion (Run / Defer / Dismiss).

If no items are accepted, skip to Step 6.

### 5b. Tool availability (once, before building plan)

For visual items only. Skip this sub-step if no accepted item has `level: visual`.

1. Resolve visual-verification config:
   - Read `.soloflow/config.json` for `verification.visual_mobile` / `verification.visual_web`.
   - Fall back to `${CLAUDE_PLUGIN_ROOT}/config/defaults.yaml` if not set.
2. For each enabled surface, probe and record the path (per `skills/visual-verify/SKILL.md` Path Selection — one decision per review run, never mix MCP and CLI):
   - **Mobile:** try `mcp__maestro__list_devices` first. On success → `mobile_path: "mcp"`. On failure, run `which maestro` via Bash; if found AND a device is booted, record `mobile_path: "cli"` and run `maestro hierarchy > /dev/null` as a live probe. Otherwise `mobile_path: null`.
   - **Web:** `which npx` via Bash. If found, attempt a light Playwright MCP navigation probe.
3. Record `{mobile_available: bool, mobile_path: "mcp"|"cli"|null, web_available: bool}`.
4. If both are unavailable, **do not abort**. Announce: "Visual verification tooling unavailable — visual stages will fall back to manual confirmation."

### 5c. Build the testing plan

Build an in-memory list of stages — one stage per accepted item. For each stage, classify:

- **Non-visual** (`level != visual`) → `kind: manual`. The user reads the action text and confirms pass/fail themselves.
- **Visual + mobile** (`level == visual` and task surface is mobile) → `kind: visual_mobile`.
- **Visual + web** → `kind: visual_web`.

Surface inference for visual items: glob `.soloflow/active/plans/**/TASK-NNN-plan.md` and read `files_owned`. Mobile: paths under `ios/`, `android/`, `app/`, RN/Expo globs. Web: `pages/`, `src/pages/`, `src/app/`, `public/`. Ambiguous → `kind: manual`.

For visual_mobile: grep `maestro/`, `.maestro/`, `test/maestro/` for a flow referencing TASK-NNN, the action text, or the blocked check; record path if found.

### 5d. Present the plan

Render the ordered plan. Prefixes: `[M]` Maestro, `[M*]` mobile-manual, `[W]` web Playwright, `[W*]` web-manual, `[?]` manual / unknown.

```
Sequential testing plan ({N} stages):
  1. [M]  TASK-011 — settings persistence (flow: login-persistence.yaml)
  2. [M*] TASK-005 — onboarding CTA color (no Maestro flow — manual)
  3. [W]  TASK-018 — inbox empty-state
  4. [?]  TASK-020 — curl /api/health and confirm 200 (manual)
Start?
```

Options:
- **Start** — begin stage iteration (5e).
- **Reorder** — follow-up free-form list for new order; re-render and re-ask.
- **Drop stages** — follow-up for IDs to drop; dropped revert to `testing_deferred`.
- **Cancel** — all accepted stages revert to `testing_deferred`; proceed to Step 6.

### 5e. Stage iteration

For each stage in order:

1. Print announcement:
   ```
   Stage {i} of {N} — TASK-NNN [{severity}]

   Kind:           {visual_mobile | visual_web | manual}
   Flow / Action:  {flow or action text}
   Plan:           {plan_file or "not found"}
   Blocked checks:
     - {check 1}
   ```
2. Run verification:
   - **visual_mobile + Maestro available:** stay on the `mobile_path` from 5b.
     - **MCP path:** `mcp__maestro__run_flow_files(...)` if a flow exists, else `mcp__maestro__run_flow(flow_yaml=...)` inline. Use `mcp__maestro__inspect_view_hierarchy` for layout; `mcp__maestro__take_screenshot` only for visual appearance (cap 3 per stage).
     - **CLI path:** `maestro test <path>` if a flow exists, else the ephemeral-flow ad-hoc pattern from `skills/visual-verify/SKILL.md`. Prefer `maestro hierarchy` over screenshot capture; cap screenshots at 3.
     - Never mix paths across stages.
   - **visual_web + Playwright available:** navigate to the relevant URL; check element presence/content; one screenshot only if appearance is under review.
   - **manual:** skip programmatic verification. Print: "tooling unavailable / manual stage — verify by hand before choosing verdict."
3. Prompt for verdict:
   `AskUserQuestion`: `Stage {i}/{N} TASK-NNN — {flow}. Verdict?`
   Options:
   - **Pass** — remove the queue entry; increment `testing_passed`.
   - **Fail — promote to TASK now** — descend into 5f to capture the issue, then queue for refinement (Step 7c). Increment `testing_failed_promoted`.
   - **Fail — defer to Deferred Visual** — descend into 5f to capture the issue, then append to the queue under `bucket: deferred_visual` (the original testing entry is removed). Increment `testing_failed_deferred`. Available only for visual stages.
   - **Skip this stage (defer)** — leave the queue entry; increment `testing_deferred`.
   - **Abort testing run** — stop iteration. Remaining stages revert to `testing_deferred`; proceed to Step 6.
4. After each stage, atomically rewrite `.soloflow/human-review-queue.md` so mid-phase abort leaves disk state consistent.

### 5f. Failure capture sub-flow

On **Fail — promote** or **Fail — defer**:

1. `AskUserQuestion` (free-form): `Describe the failure for TASK-NNN — what you saw vs expected.`
2. Build the issue payload:
   ```yaml
   source_task: TASK-NNN
   stage: {i}
   severity: {from stage}
   surface: {visual_mobile | visual_web | manual}
   flow: "{stage flow or action}"
   description: "{user text}"
   evidence: "{screenshot paths if any, else 'manual observation'}"
   logged_at: "{ISO timestamp}"
   ```
3. Branch:
   - **Promote** path: append payload to `pending_refines` (Step 7c will spawn task-refiner). Remove the original testing entry via `review-queue.js remove --task TASK-NNN --bucket testing`.
   - **Defer to Deferred Visual** path (visual stages only): append the payload as a queue entry with `type: visual_failure, bucket: deferred_visual`:
     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/state/review-queue.js" append --entry-json \
       '{"task":"TASK-NNN","type":"visual_failure","bucket":"deferred_visual","source_task":"TASK-NNN","flow":"...","description":"...","evidence":"...","severity":"...","logged_at":"..."}'
     ```
     Then remove the original testing entry. The user can review this in Step 6 of the next `/soloflow:review-queue` run.

### 5g. Commit testing pass

After all stages (or abort), if any queue changes occurred, commit:
```
chore: review-queue — testing pass ({testing_passed} passed, {testing_failed_promoted}+{testing_failed_deferred} failed, {testing_deferred} deferred)
```
Stage only `.soloflow/human-review-queue.md`.

---

## Step 6: Deferred Visual review

Skip if any of: `--decisions-only`, `--actions-only`, `--testing-only`, or `deferred_visual` is empty.

Visual failures previously deferred (in Step 5 of this run or a prior `/soloflow:review-queue` run) live here as a holding queue. Decide what to do with each.

### 6a. Bulk overview

Sort `deferred_visual` by severity then task ID. Paginate at 15 (chunks of 12).

```
{N} deferred visual failures:
  1. [HIGH] TASK-011 — settings persistence: "logo cropped on iPhone 15"
  2. [MED]  TASK-005 — onboarding CTA: "color still off on Android"
  ...
Triage how?
```

Options:
- **Promote all to TASKs** — append every entry to `pending_refines` (Step 7c spawns task-refiner). Remove from queue.
- **Re-test all** — every item joins the testing plan in 5e. Tool availability is re-probed if it wasn't already (5b).
- **Triage item-by-item** — descend into 6b.
- **Skip** — leave all in queue.

### 6b. Per-item triage

`AskUserQuestion` per item:

```
[{severity}] TASK-NNN — Deferred visual {i} of {M}

Flow:        {flow}
Description: {description}
Evidence:    {evidence}
Logged:      {logged_at}
Decision?
```

Options:
- **Promote to TASK** — append to `pending_refines`; remove from queue; increment `deferred_visual_promoted`.
- **Re-test now** — feed back into Step 5d/5e as a single-stage plan. On Pass: remove from queue, increment `deferred_visual_retested_pass`. On Fail-promote: append to `pending_refines`, increment both `deferred_visual_retested_fail` and `deferred_visual_promoted`. On Fail-defer: leave the entry in `deferred_visual`, increment `deferred_visual_retested_fail`.
- **Dismiss** — remove from queue; increment `deferred_visual_dismissed`.
- **Skip** — leave in queue.

### 6c. Commit

If any deferred-visual changes occurred:
```
chore: review-queue — deferred-visual ({deferred_visual_promoted} promoted, {deferred_visual_dismissed} dismissed)
```
Stage only `.soloflow/human-review-queue.md`.

---

## Step 7: End-of-run batch — time-intensive agent work

Run only if `pending_reverifies` or `pending_refines` is non-empty.

### 7a. Summary + confirmation

Print:

```
End-of-run batch:
  - Re-verify:  {len(pending_reverifies)} action items
  - Refine:     {len(pending_refines)} testing/visual issues → new TASKs
(Agents may take several minutes; safe to walk away.)
```

`AskUserQuestion`: `Run end-of-run batch?`

Options:
- **Run now** — proceed to 7b then 7c.
- **Run re-verifies only** — 7b only; discard `pending_refines` (list them in the final report).
- **Run refinement only** — 7c only; restore `pending_reverifies` entries to the queue (they were tentatively removed in 4b).
- **Skip both** — restore `pending_reverifies` entries; discard `pending_refines`; proceed to Step 8.

When restoring tentatively removed re-verify entries: for each `pending_reverifies[*].original_entry`, re-append via `review-queue.js append --entry-json`, atomic rewrite, and commit `chore: review-queue — restore {N} deferred re-verify entries`.

### 7b. Re-verifications

Iterate `pending_reverifies` sequentially.

For each entry:

1. Locate the plan: prefer `pending_reverifies[i].plan_path`; otherwise re-glob `.soloflow/active/plans/**/TASK-NNN-plan.md`. If still missing, use the done report (`pending_reverifies[i].done_report_path` or re-glob `.soloflow/archive/done/**/TASK-NNN-done.md`). If neither exists, skip and log a warning in the final report.
2. Spawn the **shadow-verifier** agent (`subagent_type: "shadow-verifier"`) with prompt:

   > Re-verify TASK-NNN. The deferred check below has been completed by the user; validate **only this check** — do not re-run the full Level 1–5 pipeline.
   >
   > Blocked checks:
   > - {check 1}
   >
   > Plan + prior done report are attached. Return your verdict in the standard format.

   Attach the plan body and done report (if present).
3. Handle verdict:
   - **APPROVED** / **APPROVED_WITH_DEFERRED** — entry stays removed (was removed tentatively in 4b); increment `actions_completed`.
   - **NEEDS_CHANGES** — restore `original_entry` to the queue with a new `last_reverify_notes:` field containing the verifier's changes-required list; increment `actions_needs_changes`. Surface in final report with hint *"Use /soloflow:quick to fix."*
   - **HUMAN_NEEDED** — restore `original_entry` (re-bucketed to `decisions` if originally not there) with an updated reason.
   - **CONTEXT_LIMIT** — read the verifier's `### Handoff` section. Respawn a fresh shadow-verifier once (budget: 1 respawn per re-verify); if respawn also returns CONTEXT_LIMIT, restore the entry and note in the final report.
4. Atomic rewrite of `human-review-queue.md` per verdict.

After all re-verifies complete (or are all restored), commit:
```
chore: review-queue — batch re-verify ({actions_completed} approved, {actions_needs_changes} needs-changes)
```
Stage only `.soloflow/human-review-queue.md`.

### 7c. Refinements → backlog tasks

Skip if `pending_refines` is empty.

Each `pending_refines` entry is a single bug-fix task — no slice decomposition needed. We spawn one `task-refiner` per item, in parallel, using the agent's single-task detail mode (the per-item brief is the skeleton). No `task-decomposer` runs here.

1. Resolve config:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" \
       --key models.task_refiner --key parallelism.task_refiner_parallel \
       --key limits.context_limit_respawn_max \
       --fallback opus --fallback true --fallback 3
   ```
2. Compute the starting TASK ID via `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/next-ids.js" --kind task`.
3. Discover existing epics: glob `.soloflow/active/plans/*/EPIC-*.md`.
4. **Allocate real TASK-NNN IDs sequentially** for the batch — one per `pending_refines` entry, in source order, starting from step 2's counter.
5. **Build per-item briefs.** Each brief retains the existing template fields:

   ```
   - Title: {truncated description, ~60 chars}
   - Source task: TASK-{source_task} ({severity}, {surface})
   - Original flow: "{flow}"
   - Problem: {full description}
   - Proposed direction: Investigate root cause in TASK-{source_task}'s owned files; fix without regressing the original flow.
   - Evidence: {evidence}
   - Scope: Bug fix only — do not expand scope.
   ```

6. **Spawn one task-refiner per item in parallel.** Issue **one message containing one `Agent` tool call per `pending_refines` entry** (`subagent_type: "task-refiner"`, `model: <resolved task_refiner>`). When `parallelism.task_refiner_parallel` resolves to `false`, fall back to a single sequential pass per item — same prompt shape, just one Agent call at a time.

   Each call's prompt:
   ```
   MODE: detail
   TASK_ID: TASK-{NNN}
   TASK_SKELETON:
     {
       "slot": "T1",
       "title": "{title from brief}",
       "scope_summary": "Bug fix: {description}. Boundary: do not expand scope.",
       "epic": null,
       "depends_on": [],
       "estimated_complexity": "low",
       "files_owned_hint": [],
       "files_readonly_hint": [],
       "is_external_cli_step": false
     }
   SIBLING_DAG:
     (none — single-task batch entry)

   # Brief
   These work items were surfaced by /soloflow:review-queue during the testing pass on {ISO date}.

   {per-item brief from step 5}

   # Existing epics (for context — do NOT propose new slugs)
   {slug + EPIC-{slug}.md contents for each}
   ```

   The detailer is expected to expand `files_owned`/`files_readonly` from the source task's owned files and the per-item evidence; the empty hints are an explicit "decide for yourself" signal in this single-task bug-fix context.

   Wait for all calls to return.

7. **Collate per-item.** For each `pending_refines` entry's detailer output:
   - On `CONTEXT_LIMIT`: respawn that one item with handoff (cap at resolved `limits.context_limit_respawn_max`). Do not respawn siblings.
   - Apply parity gates 3a/3b from `commands/planner.md` per plan.
   - On terminal failure (no parseable plan after respawn cap): drop that item, surface in the final review-queue report under `Refinement failures`, and proceed.

8. **Write plans.** For each successful plan:
   - Write to `.soloflow/active/plans/TASK-{NNN}-plan.md` (respect epic subfolder if the detailer assigned one — though in this path orphan tasks are the common case). Use `wx`/noclobber semantics; on collision, recompute the next ID and retry.
   - The plan's frontmatter MUST carry `status: ready` — that frontmatter IS the queue entry; no separate queue file to update.
   - If the detailer expanded into an existing epic subfolder, that's fine. New epics are not produced here (review-queue refinements are bug fixes; the detailer should not propose new epics in detail mode anyway).

9. Set `tasks_created = <count of new plans>`.

10. Stage only the new plan files. Commit:
    ```
    feat: review-queue — plan TASK-{first}..TASK-{last} from testing issues
    ```

---

## Step 8: Final report

Print:

```
## Review Queue — complete

Cruft resolved              : {cruft_resolved}
Decisions resolved          : {decisions_resolved}
Decisions deferred           : {decisions_deferred}
Decisions dismissed         : {decisions_dismissed}
Actions completed           : {actions_completed}
Actions needs-changes       : {actions_needs_changes}
Actions deferred             : {actions_deferred}
Actions dismissed           : {actions_dismissed}
Testing passed               : {testing_passed}
Testing failed (promoted)   : {testing_failed_promoted}
Testing failed (deferred)   : {testing_failed_deferred}
Testing deferred             : {testing_deferred}
Deferred Visual promoted    : {deferred_visual_promoted}
Deferred Visual re-tested  : {deferred_visual_retested_pass}/{deferred_visual_retested_fail} (pass/fail)
Deferred Visual dismissed   : {deferred_visual_dismissed}
New backlog tasks           : {tasks_created} ({TASK-first..TASK-last if any})

Queue status:
  Pending items : {remaining pending_count}
  Per bucket    : decisions={N} actions={N} testing={N} deferred_visual={N}
```

If there are discarded issues (Step 7a's "Skip refinement"), append a `Discarded issues:` block listing each verbatim.

If `actions_needs_changes > 0`, list them with `last_reverify_notes` and hint:
```
Needs-changes actions:
  - TASK-NNN: {short changes-required summary}
    → /soloflow:quick "<short task description>"
```

If `legacy_sprint_code_review_seen > 0`, append a hint:
```
Legacy queue entries:
  {N} `type: sprint_code_review` entries are deprecated (sprint-code-reviewer
  now writes findings directly to the per-sprint findings file). Either:
    - hand-edit `.soloflow/human-review-queue.md` to delete them, or
    - run for each unique SPRINT-NNN task field:
      node "${CLAUDE_PLUGIN_ROOT}/scripts/state/review-queue.js" remove --task SPRINT-NNN --type sprint_code_review
  The compounder picks up new sprint-code-review findings automatically.
```

End with:
```
Next steps:
  /soloflow:review-queue     — run again to continue triage
  /soloflow:sprint           — execute newly planned tasks
  /soloflow:quick            — fix needs-changes items
```

---

## Important notes

- **Never `git add .` or `-A`.** Every commit stages only explicit paths. Matches global atomic-commits policy.
- **Skip commits silently** if the project is not a git repo or `.soloflow/` is gitignored.
- **Atomic queue writes:** every modification to `.soloflow/human-review-queue.md` uses temp-file + rename so abort never leaves half-written content.
- **Never mix Maestro MCP and CLI within one review run:** both bind port 7001. Pick one path at Step 5b and use it for every visual stage. Within the chosen path, also serialize against the same device — don't run two Maestro operations in parallel.
- **Re-verify budget:** one respawn per re-verify on CONTEXT_LIMIT; one respawn total for the task-refiner.
- **Pagination:** bulk-classification prompts paginate at 15 items / chunks of 12 to stay within AskUserQuestion's text budget.
- **Bucket scoping:** `--decisions-only`, `--actions-only`, `--testing-only`, `--deferred-visual-only` narrow which interactive steps run. Step 7 (end-of-run batch) runs whenever `pending_reverifies` or `pending_refines` is non-empty.
- If the user passes an unrecognized `$ARGUMENTS`, print usage:
  ```
  /soloflow:review-queue [--skip-cruft | --decisions-only | --actions-only | --testing-only | --deferred-visual-only]
  ```
  and stop.

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current per-item decision, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction (if one is running in Step 7), write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
