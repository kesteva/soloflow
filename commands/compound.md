---
description: Propose learnings from a completed sprint in three buckets (clean-ups, backlog tasks, CLAUDE.md improvements) plus optional SoloFlow self-improvement feedback (tester mode), then apply what the user approves
argument-hint: [optional: SPRINT-NNN]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:compound

Phase 6 of the SoloFlow pipeline. Reads done reports, stuck reports, human review notes, and the out-of-scope findings queue from a completed sprint, then produces a three-bucket proposal for the user to review one bucket at a time. The main agent (you) applies approved items directly for clean-ups and CLAUDE.md edits, and spawns the task-refiner for backlog tasks.

Target: **$ARGUMENTS** (optional — sprint selector). Accepted values:
- `SPRINT-NNN` — compound that specific sprint
- `--all` — compound every pending sprint, oldest first, one at a time
- `--oldest` — silently pick the oldest pending sprint
- empty — pick the single pending sprint; prompt if two or more exist

---

## Model resolution (applies to every Agent spawn below)

Before invoking the Agent tool, resolve `models.<name>` per the three-tier
recipe in [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
and pass the resolved value as the Agent tool's `model` parameter.

Mapping used in this command:
- `compounder` → `models.compounder` (fallback: `sonnet`)
- `claude-md-reviewer` → `models.claude_md_reviewer` (fallback: `opus`) — pre-review of Bucket C in Step 2.5
- `compound-skeptic` → `models.compound_skeptic` (fallback: `opus`) — per-item IMPLEMENT / DONT_IMPLEMENT verdicts in Step 2.6
- `task-refiner` → `models.task_refiner` (fallback: `opus`) — used when materializing backlog items

## Limits resolution

Resolve `limits.context_limit_respawn_max` (fallback: 3) at run start and use
it wherever "Cap at 3 respawns" appears below.

## Step 0: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Identify the sprint(s) to compound

**Resolve `compound.pending_sprints.picker_threshold`** per the three-tier recipe (fallback: `2`). Name this `PICKER_THRESHOLD` below.

**Discover pending sprints.** A sprint is *pending compound* when:
- `.soloflow/active/findings/SPRINT-*-findings.md` exists for it AND
- `.soloflow/archive/compound/SPRINT-*-proposal.md` does NOT exist for it.

Glob `.soloflow/active/findings/SPRINT-*-findings.md`, strip `-findings.md`, and drop any whose archive slot already exists. Sort the remaining list by numeric suffix ascending (oldest-first). Call this `PENDING`.

**Interpret `$ARGUMENTS`:**

1. **`$ARGUMENTS == SPRINT-NNN`** → target that sprint. If `PENDING` is non-empty and doesn't include it, still allow (user may be re-running against a legacy state). Proceed to the idempotency guard.
2. **`$ARGUMENTS == --all`** → if `PENDING` is empty, report "No pending sprints to compound." and stop. Otherwise set `MODE=all` and iterate this command's Steps 2–6 once per pending sprint, oldest-first, stopping between sprints if any user prompt bails out.
3. **`$ARGUMENTS == --oldest`** → if `PENDING` is empty, report and stop. Otherwise pick the first entry silently and continue with that sprint.
4. **`$ARGUMENTS` empty:**
   - `PENDING` length 0 → report "No pending sprints to compound." and stop.
   - `PENDING` length 1 → use it silently.
   - `PENDING` length ≥ `PICKER_THRESHOLD` → use **AskUserQuestion** with one option per pending sprint (showing its ID and the in-sprint findings `pending_count`) plus a final "Compound all pending (oldest → newest)" option. If the user picks "all", set `MODE=all` and iterate as in case 2.

**Idempotency guard** (per selected sprint): if `.soloflow/archive/compound/SPRINT-{NNN}-proposal.md` already exists, report "SPRINT-{NNN} already compounded. Skipping." and stop (or move to the next sprint in `MODE=all`).

**Collect relevant inputs for the selected sprint:**
- Done reports under `.soloflow/archive/done/` (recursive — may be under epic subfolders)
- Stuck reports under `.soloflow/active/stuck/`
- The sprint's findings file at `.soloflow/active/findings/SPRINT-{NNN}-findings.md`
- `.soloflow/human-review-queue.md`

**Legacy findings migration (one-shot per project):** If the per-sprint findings file does NOT exist for the selected sprint BUT a legacy `.soloflow/active/findings.md` is present, treat the legacy file as this sprint's findings (read it directly and pass its path to the compounder). After Step 5 archives the sprint's proposal, delete the legacy file.

If nothing was done and nothing was logged (empty done/stuck dirs AND empty findings file), report "No completed tasks or findings to learn from." and stop.

## Step 2: Spawn the compounder

1. **Ensure** `.soloflow/active/compound/` exists (`mkdir -p`). The per-sprint draft will be written there.
2. **Resolve `tester` flag.** Check `.soloflow/config.json` first, then `config/defaults.yaml` (via `${CLAUDE_PLUGIN_ROOT}`). If `tester: true`, pass `tester: true` to the compounder so it produces bucket D (SoloFlow improvements). Otherwise omit it.
3. Spawn the **compounder** agent via the Agent tool with:
   - The target sprint ID
   - Paths to all done reports, stuck reports, the sprint's findings file (per-sprint path, or the legacy `active/findings.md` if the migration branch applies), and human-review-queue.md
   - If tester mode is on: `tester: true`
   - Instruction: "Produce `.soloflow/active/compound/{sprint_id}-proposal.md` with three buckets (A clean-ups, B backlog tasks, C CLAUDE.md / CODE-PATTERNS.md improvements). Route each C-item to the correct target file — rules and constraints go to CLAUDE.md, code patterns go to CODE-PATTERNS.md. {If tester: Also produce bucket D (SoloFlow improvements).} Do not apply anything. Cite concrete evidence for every item."
4. Wait for the compounder to finish.
   - If the compounder reports **CONTEXT_LIMIT**: read the `### Handoff` section. If a partial `active/compound/{sprint_id}-proposal.md` was written, read it. Spawn a **fresh compounder** with the remaining un-triaged inputs and the partial proposal content. Merge results. Cap at resolved `limits.context_limit_respawn_max`.
   Read the resulting `active/compound/{sprint_id}-proposal.md`.

## Step 2.5: Pre-review Bucket C (claude-md-reviewer)

Runs before the user sees any options, so the C-bucket presented in Step 3 is already tightened.

1. **Resolve `compound.claude_md_reviewer.enabled`** per the three-tier recipe (fallback: `true`). If `false`, skip this step entirely and carry raw C-items into Step 3.
2. Parse Bucket C from `active/compound/{sprint_id}-proposal.md`. If the bucket is empty (`_No items._`) or has zero entries, skip.
3. Spawn the **claude-md-reviewer** agent with:
   - The full list of C-items (all of them — not user-filtered)
   - The target sprint ID
   - Instruction: *"Review every proposed CLAUDE.md / CODE-PATTERNS.md improvement against the existing codebase and CLAUDE.md files. Produce tightly scoped diffs at the lowest appropriate directory level. Reject redundant, stale, or overly broad proposals with a reason code. When an item mixes rule content and pattern content, SPLIT it into two ready items (one for CLAUDE.md, one for CODE-PATTERNS.md) both tagged source_item: C{n}."*
   - Handle **CONTEXT_LIMIT** respawns identically to Step 2 (capped at resolved `limits.context_limit_respawn_max`).
4. **Rewrite Bucket C in the proposal file** using the reviewer's output:
   - **Ready items:** replace the original item's content with the reviewer's refined diff + `**Status:** ready` tag. Preserve the item's title and source citation. For split items, insert both halves contiguously and keep both with their `source_item: C{n}` tag.
   - **Rejected items:** flatten to an info-only block with heading `### C{n}. {title} [dropped — {reason}]` and a single `**Reason:** {one sentence}` line. Do NOT include the original diff.
   - Re-number the **ready items** sequentially (`C1..Cm`) so "Approve some" can reference them unambiguously. Keep the original `source_item` tag inside each item so the audit trail is preserved. Rejected items keep their `[dropped]` prefix and do not consume an index.
5. If every C-item was rejected, note it for Step 3 (present dropped list info-only; skip the approve/reject prompt for C entirely).

## Step 2.6: Skeptic review (compound-skeptic)

Adds per-item IMPLEMENT / DONT_IMPLEMENT verdicts before the user sees options, giving the user an informed "accept skeptic's recommendations" shortcut in Step 3.

1. **Resolve `compound.skeptic.enabled`** per the three-tier recipe (fallback: `true`). If `false`, skip this step entirely — Step 3 will omit the "Accept skeptic's recommendations" option.
2. If every bucket is empty (`_No items._` in A, B, C, and D or D absent), skip — there's nothing to verdict.
3. Spawn the **compound-skeptic** agent with:
   - The target sprint ID
   - The absolute path to `active/compound/{sprint_id}-proposal.md`
   - (Optional) paths to the sprint's findings file and done reports for evidence
   - Instruction: *"Walk every live item (skip `[dropped]`). Run 2–4 read-only checks per item. Insert a `### Skeptic Verdict` block under each with verdict, confidence, one-paragraph cited reasoning, and an optional counterfactual. Default to DONT_IMPLEMENT only when you have concrete evidence."*
4. Handle **CONTEXT_LIMIT** respawns identically to Steps 2 and 2.5 (capped at resolved `limits.context_limit_respawn_max`). Preserve the skeptic's partial verdicts — a fresh skeptic picks up where the last one left off using the proposal file's existing Skeptic Verdict blocks as the record.
5. After the skeptic returns `REPORTED`, re-read the proposal. Note per-bucket counts: `{implement}` / `{dont}` / `{skipped-dropped}` for use in Step 3.

## Step 3: Present proposal and collect approvals — one bucket at a time

Walk through each bucket sequentially. For each non-empty bucket:

1. Build a compact summary: item count and one-line title per item.
2. Use **AskUserQuestion** with the summary **embedded in the question text** (not printed separately before the call — text printed before AskUserQuestion gets visually cut off by the question UI). Format the question as:

   `Bucket {letter} — {name} ({N} items): {one-line title per item, comma-separated}. Approve?`

   Options:
   - **Approve all** — accept every item in this bucket
   - **Approve some** — user lists which items to keep (e.g., `A1, A3`); anything unlisted is rejected
   - **Reject all** — skip this bucket entirely
   - **Accept skeptic's recommendations** — accept every item the skeptic marked `IMPLEMENT`; reject every item marked `DONT_IMPLEMENT`. **Only include this option** when the skeptic ran (Step 2.6 was enabled and reached REPORTED) AND the bucket has at least one `DONT_IMPLEMENT` verdict. Omit it when every verdict is `IMPLEMENT` (in that case it degenerates into "Approve all") or when the skeptic was disabled / failed.
   - **Give feedback** — user provides notes; re-run the compounder for this bucket only with the feedback appended, then re-present
3. Record the per-bucket decisions before moving to the next bucket. If the user picked "Accept skeptic's recommendations", record the split explicitly so Step 6's report can call out `{N applied (skeptic IMPLEMENT) / M proposed}`.

**Bucket C presentation (after claude-md-reviewer pre-review):**

Bucket C's summary has two parts:
- Count of ready items — *approvable*. Use `Cn` indices from the renumbered list.
- Count of dropped items — *info-only*, with their reason codes. Shown as `[dropped — reason]`. Not indexable by "Approve some".

Question format: `Bucket C — CLAUDE.md / CODE-PATTERNS.md improvements: {m} approvable, {k} dropped by reviewer ({reason codes}). {approvable titles comma-separated}. Approve?`

- "Approve all" accepts every ready item.
- "Approve some" lists ready indices only (e.g., `C1, C3`); unlisted ready items are rejected.
- If every C-item was dropped (`m == 0`), skip the AskUserQuestion entirely — just print the dropped list as info and continue to the next bucket.
- **"Give feedback" on Bucket C:** re-run the compounder with the feedback appended **and then re-run Step 2.5** (claude-md-reviewer) before re-presenting. Cap the loop at resolved `compound.claude_md_reviewer.pre_review_feedback_rounds` (fallback: `2`). When the cap is hit, print `Feedback budget exhausted — using last reviewer output as final.` and treat the current state of Bucket C as the final presentation. Feedback on buckets A/B/D does not re-trigger Step 2.5.

**Bucket D exception (SoloFlow improvements):** Do not use the standard approve/reject flow. Instead:
1. Print the full feedback write-up inline so the user can read and copy it directly.
2. If the skeptic ran and emitted any `DONT_IMPLEMENT` verdicts on D-items, print a one-line summary first: `Skeptic marked {N} of {M} recommendations IMPLEMENT.` If every D-item is `IMPLEMENT`, omit the summary.
3. Use **AskUserQuestion**: `SoloFlow feedback ready. Archive and continue?` with options:
   - **Approve** — archive as-is to `SPRINT-{NNN}-feedback.md`. If any D-item is `DONT_IMPLEMENT`, silently strip those items from the archived write-up and include a final `skeptic_stripped:` section listing their titles + reasoning so the audit trail is preserved.
   - **Edit** — user provides edits; revise the write-up, re-print, and re-ask
   - **Reject** — discard, skip archiving
4. If approved, write to `.soloflow/archive/compound/SPRINT-{NNN}-feedback.md` and commit. No further action needed in Step 4.

If a bucket is empty (`_No items._`), skip it silently — do not present an empty picker.

After all buckets have been reviewed, print a one-line summary of accepted/rejected counts across all buckets, then proceed to Step 4.

## Step 4: Apply approved items

Use atomic commits per the global atomic-commits rule.

### Bucket A — clean-ups
For each approved A-item:
1. Make the edits described in the proposal using `Edit` / `Write`.
2. Commit with `chore({sprint}): {title}` including only the files touched by this item.
3. Do not batch multiple A-items into one commit.

### Bucket B — backlog tasks (refine into plans)
For the set of approved B-items, produce execution-ready task plans by spawning the **task-refiner** agent:

1. Compute the starting task counter from the filesystem (see "ID allocation" in the project `CLAUDE.md`).
2. Discover existing epics (glob `.soloflow/active/plans/*/EPIC-*.md`).
3. Assemble the approved B-items into a single brief: for each item include its title, problem, proposed direction, scope, and source. Prefix with: *"These work items were surfaced by the compounder during SPRINT-{NNN}. Refine each into an execution-ready task plan."*
4. Spawn the **task-refiner** agent via the Agent tool with the brief, starting task counter, and existing epics — same interface as `/soloflow:planner` Step 2.
5. Capture the output. Parse into individual plan files and any new EPIC-{slug}.md blocks.
6. Write each plan file to `.soloflow/active/plans/` (respecting epic subfolders), using `noclobber`/`wx` semantics. Retry on collision.
7. Add each task to `.soloflow/active/backlog.json` with `status: "ready"`.
8. Commit `feat({sprint}): plan TASK-{NNN}..TASK-{MMM} from compound` including all plan files and backlog.json.

### Bucket C — CLAUDE.md / CODE-PATTERNS.md improvements

The diffs are already tightened by Step 2.5. No re-spawn of claude-md-reviewer here.

For each approved C-item (already `ready` in the proposal):
1. Read the item's `**Target file:**` and `**Diff:**`.
2. Apply the diff using `Edit` (or `Write` if the target file does not exist — applies when creating a new scoped CLAUDE.md or CODE-PATTERNS.md).
3. Commit with `docs({sprint}): {title}` per item.

Dropped items (from Step 2.5) are never applied — they stay in the archived proposal as an audit trail only.

### Bucket D — SoloFlow improvements (tester mode only)

Bucket D is handled entirely in Step 3 (write-up presented inline, feedback file archived). No action needed here. If no D-items exist (tester mode off), skip entirely.

---

If any application step fails (e.g., a diff doesn't apply cleanly because the target file changed), stop that item, log the error to the summary, and continue with the rest. Never roll back committed items.

## Step 5: Archive & sweep

1. Move `.soloflow/active/findings/SPRINT-{NNN}-findings.md` → `.soloflow/archive/findings/SPRINT-{NNN}-findings.md`. (Do NOT recreate an empty file — the next sprint's findings file is created by sprint-initiator, not here.)
2. Move `.soloflow/active/compound/SPRINT-{NNN}-proposal.md` → `.soloflow/archive/compound/SPRINT-{NNN}-proposal.md` (preserves rejected items for later reference).
3. **Legacy findings cleanup:** if this run used a legacy `.soloflow/active/findings.md` via the Step 1 migration branch, delete the legacy file now (its contents were captured by the archived per-sprint findings file).
4. Commit `chore({sprint}): archive findings + compound proposal`.

If running in `MODE=all`, loop back to Step 1's idempotency guard for the next pending sprint. Stop when `PENDING` is empty.

## Step 6: Report

Print a one-screen summary:

```
Compound complete for SPRINT-{NNN}.

Applied:
  A. Clean-ups       : {N applied} / {skeptic_implement} IMPLEMENT / {M proposed}  (commits: {hashes})
  B. Backlog tasks   : {N planned} / {skeptic_implement} / {M proposed}  (TASK-{first}..TASK-{last})
  C. CLAUDE.md edits : {N applied} / {skeptic_implement} / {M proposed}  ({files touched})
  D. SoloFlow feedback: {N archived} / {skeptic_implement} / {M proposed}  (SPRINT-{NNN}-feedback.md)  {only if tester mode}

Rejected : {N} (preserved in archive/compound/SPRINT-{NNN}-proposal.md)
Findings : archived → archive/findings/SPRINT-{NNN}-findings.md
```

The `{skeptic_implement}` column reflects how many items the skeptic endorsed per bucket. Omit the column entirely (just show `{N applied} / {M proposed}`) if the skeptic was disabled or did not run.

**`MODE=all` wrap-up:** after the final pending sprint is processed, print a one-line roll-up (`Compounded {N} sprints: SPRINT-A, SPRINT-B, ...`).

---

## Notes

- This command mutates the codebase for approved clean-ups and CLAUDE.md edits. Bucket B spawns the task-refiner to produce plans.
- The compounder agent is read-only except for its own per-sprint proposal draft (`active/compound/SPRINT-NNN-proposal.md`) — it never writes directly to plans or CLAUDE.md.
- The claude-md-reviewer agent runs as a pre-review in Step 2.5, tightening Bucket C before the user sees options. It can only edit the proposal file to insert `[reviewer: ready]` / `[dropped — reason]` markers and refined diffs.
- The compound-skeptic agent runs in Step 2.6 (after claude-md-reviewer), adding per-item IMPLEMENT / DONT_IMPLEMENT verdicts to non-dropped items. It enables the "Accept skeptic's recommendations" option. Toggle via `compound.skeptic.enabled`.
- Rejected items are preserved in the archived proposal so they can be revisited manually.
- Multiple sprints can await compound simultaneously. This command enables a compound backlog — use `--all` to drain it in one go, or pick a specific sprint.

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
