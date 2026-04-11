---
description: Propose learnings from a completed sprint in three buckets (clean-ups, backlog tasks, CLAUDE.md improvements) plus optional SoloFlow self-improvement feedback (tester mode), then apply what the user approves
argument-hint: [optional: SPRINT-NNN]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:compound

Phase 6 of the SoloFlow pipeline. Reads done reports, stuck reports, human review notes, and the out-of-scope findings queue from a completed sprint, then produces a three-bucket proposal for the user to review one bucket at a time. The main agent (you) applies approved items directly for clean-ups and CLAUDE.md edits, and spawns the task-refiner for backlog tasks.

Target sprint: **$ARGUMENTS** (optional — defaults to the most recently completed sprint)

---

## Step 0: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Identify the sprint

1. If `$ARGUMENTS` names a sprint (`SPRINT-NNN`), use it.
2. Otherwise read `.soloflow/active/sprint.json`. If `sprint.status == "complete"`, use it. Otherwise find the most recently completed sprint (check `archive/compound/` for prior proposals to infer, or ask the user).
3. **Idempotency guard:** If `.soloflow/archive/compound/SPRINT-{NNN}-proposal.md` already exists, this sprint has already been compounded. Report that and stop (unless the user explicitly re-requests).
4. Collect relevant reports:
   - Done reports under `.soloflow/archive/done/` (recursive — may be under epic subfolders)
   - Stuck reports under `.soloflow/active/stuck/`
   - `.soloflow/active/findings.md`
   - `.soloflow/human-review-queue.md`
5. If nothing was done and nothing was logged, tell the user: "No completed tasks or findings to learn from." and stop.

## Step 2: Spawn the compounder

1. **Resolve `tester` flag.** Check `.soloflow/config.json` first, then `config/defaults.yaml` (via `${CLAUDE_PLUGIN_ROOT}`). If `tester: true`, pass `tester: true` to the compounder so it produces bucket D (SoloFlow improvements). Otherwise omit it.
2. Spawn the **compounder** agent via the Agent tool with:
   - The target sprint ID
   - Paths to all done reports, stuck reports, findings.md, and human-review-queue.md
   - If tester mode is on: `tester: true`
   - Instruction: "Produce `.soloflow/active/COMPOUND-PROPOSAL.md` with three buckets (A clean-ups, B backlog tasks, C CLAUDE.md improvements). {If tester: Also produce bucket D (SoloFlow improvements).} Do not apply anything. Cite concrete evidence for every item."
3. Wait for the compounder to finish. Read the resulting `COMPOUND-PROPOSAL.md`.

## Step 3: Present proposal and collect approvals — one bucket at a time

Walk through each bucket sequentially. For each non-empty bucket:

1. Print a compact summary: item count and one-line title per item.
2. Use **AskUserQuestion** with the bucket name as header and these options:
   - **Approve all** — accept every item in this bucket
   - **Approve some** — user lists which items to keep (e.g., `A1, A3`); anything unlisted is rejected
   - **Reject all** — skip this bucket entirely
   - **Give feedback** — user provides notes; re-run the compounder for this bucket only with the feedback appended, then re-present
3. Record the per-bucket decisions before moving to the next bucket.

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

### Bucket C — CLAUDE.md improvements
Spawn the **claude-md-reviewer** agent to review and tighten the approved C-items before applying:

1. Pass all approved C-items to the claude-md-reviewer agent with instruction: *"Review these proposed CLAUDE.md improvements against the existing codebase and CLAUDE.md files. Produce tightly scoped diffs at the lowest appropriate directory level. Reject redundant, stale, or overly broad proposals."*
2. Wait for the reviewer's output. For each item it marks `ready`:
   - Apply the diff to the target file using `Edit`. If the target file doesn't exist (e.g., a new scoped CLAUDE.md or CODE-PATTERNS.md), create it with `Write`.
   - Commit with `docs({sprint}): {title}` per item.
3. For items the reviewer rejects (redundant / stale / too-broad / belongs-in-code-patterns): skip them. Note in the final report which were rejected and why.

### Bucket D — SoloFlow improvements (tester mode only)

This bucket is NOT applied to the current project. It is a self-contained write-up of problems and recommendations for the SoloFlow plugin itself, meant to be passed back to the SoloFlow maintainer (the user, in the SoloFlow plugin project).

For each approved D-item:
1. No edits are made — this bucket is informational only.

After all D-items are reviewed, write the approved items to `.soloflow/archive/compound/SPRINT-{NNN}-feedback.md` as a standalone document that can be copy-pasted into a SoloFlow project conversation. Commit with `docs({sprint}): archive soloflow tester feedback`.

If no D-items exist (tester mode off), skip this entirely.

---

If any application step fails (e.g., a diff doesn't apply cleanly because the target file changed), stop that item, log the error to the summary, and continue with the rest. Never roll back committed items.

## Step 5: Archive & sweep

1. Move `.soloflow/active/findings.md` → `.soloflow/archive/findings/SPRINT-{NNN}-findings.md`.
2. Recreate an empty findings file at `.soloflow/active/findings.md` with `pending_count: 0` and `last_updated: null`.
3. Move `.soloflow/active/COMPOUND-PROPOSAL.md` → `.soloflow/archive/compound/SPRINT-{NNN}-proposal.md` (preserves rejected items for later reference).
4. Commit `chore({sprint}): archive findings + compound proposal`.

## Step 6: Report

Print a one-screen summary:

```
Compound complete for SPRINT-{NNN}.

Applied:
  A. Clean-ups       : {N applied} / {M proposed}  (commits: {hashes})
  B. Backlog tasks   : {N planned} / {M proposed}  (TASK-{first}..TASK-{last})
  C. CLAUDE.md edits : {N applied} / {M proposed}  ({files touched})
  D. SoloFlow feedback: {N archived} / {M proposed}  (SPRINT-{NNN}-feedback.md)  {only if tester mode}

Rejected : {N} (preserved in archive/compound/SPRINT-{NNN}-proposal.md)
Findings : archived → archive/findings/SPRINT-{NNN}-findings.md
```

---

## Notes

- This command mutates the codebase for approved clean-ups and CLAUDE.md edits. Bucket B spawns the task-refiner to produce plans.
- The compounder agent is read-only except for `COMPOUND-PROPOSAL.md` — it never writes directly to plans or CLAUDE.md.
- The claude-md-reviewer agent is read-only — it reviews proposals and produces diffs; the main agent applies them.
- Rejected items are preserved in the archived proposal so they can be revisited manually.
