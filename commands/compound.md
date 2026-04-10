---
description: Propose learnings from a completed sprint in four buckets (clean-ups, backlog ideas, CLAUDE.md improvements, reusable patterns) plus optional SoloFlow self-improvement feedback (tester mode), then apply what the user approves
argument-hint: [optional: SPRINT-NNN]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:compound

Phase 6 of the SoloFlow pipeline. Reads done reports, stuck reports, human review notes, and the out-of-scope findings queue from a completed sprint, then produces a four-bucket proposal for the user to approve. The main agent (you) applies approved items directly — no new tasks are created for clean-ups or CLAUDE.md edits.

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

1. Compute starting `solutions` and `ideas` counters from the filesystem (see "ID allocation" in the project `CLAUDE.md`): glob `.soloflow/archive/solutions/**/SOL-*.md` and `.soloflow/active/ideas/IDEA-*.md` for the respective maxes.
2. **Resolve `tester` flag.** Check `.soloflow/config.json` first, then `config/defaults.yaml` (via `${CLAUDE_PLUGIN_ROOT}`). If `tester: true`, pass `tester: true` to the compounder so it produces bucket E (SoloFlow improvements). Otherwise omit it.
3. Spawn the **compounder** agent via the Agent tool with:
   - The target sprint ID
   - Paths to all done reports, stuck reports, findings.md, and human-review-queue.md
   - Starting counters (computed from filesystem above — used only for display in the proposal; the main agent recomputes at apply time)
   - If tester mode is on: `tester: true`
   - Instruction: "Produce `.soloflow/active/COMPOUND-PROPOSAL.md` with four buckets (A clean-ups, B backlog ideas, C CLAUDE.md improvements, D reusable patterns). {If tester: Also produce bucket E (SoloFlow improvements).} Do not apply anything. Cite concrete evidence for every item."
3. Wait for the compounder to finish. Read the resulting `COMPOUND-PROPOSAL.md`.

## Step 3: Present proposal and collect approvals

Summarize the proposal to the user in a compact format — for each bucket, show item counts and one-line titles. Point them to `COMPOUND-PROPOSAL.md` for full detail.

Then use `AskUserQuestion` to gather approval. Offer, at minimum:
- **Approve all** — apply every item in every bucket
- **Approve some** — user lists which items to accept (`A1, A3, B1, C1, D1-D3` style)
- **Reject all** — archive the proposal, apply nothing

If the user chooses "Approve some," collect the list of accepted item IDs and treat anything not listed as rejected.

## Step 4: Apply approved items

For each approved item, apply directly — do NOT spawn a subagent, do NOT create new tasks. Use atomic commits per the global atomic-commits rule.

### Bucket A — clean-ups
For each approved A-item:
1. Make the edits described in the proposal using `Edit` / `Write`.
2. Commit with `chore({sprint}): {title}` including only the files touched by this item.
3. Do not batch multiple A-items into one commit.

### Bucket B — backlog ideas
For each approved B-item:
1. Recompute the next IDEA ID from the filesystem (glob `.soloflow/active/ideas/IDEA-*.md`, max + 1) — do this per-item so sequential writes don't collide.
2. Write `.soloflow/active/ideas/IDEA-{NNN}.md` using the standard idea frontmatter and the body from the proposal, with `noclobber`/`wx` semantics. Retry with the next ID on collision.
3. Commit `feat({sprint}): queue IDEA-{NNN} from compound` after the batch of idea files (one commit for all B-items is fine — ideas are just files).

### Bucket C — CLAUDE.md improvements
For each approved C-item:
1. Apply the diff to the target CLAUDE.md file using `Edit`.
2. Commit with `docs({sprint}): {title}` per item.

### Bucket D — reusable patterns
For each approved D-item:
1. Create `.soloflow/archive/solutions/SPRINT-{NNN}/` if it doesn't exist.
2. Recompute the next SOL ID from the filesystem (glob `.soloflow/archive/solutions/**/SOL-*.md`, max + 1) — do this per-item.
3. Write `.soloflow/archive/solutions/SPRINT-{NNN}/SOL-{NNN}.md` with the SOL body from the proposal, using `noclobber`/`wx`. Retry with the next ID on collision.
4. Commit `docs({sprint}): archive SOL-{NNN}..SOL-{MMM}` for the batch.

### Bucket E — SoloFlow improvements (tester mode only)

This bucket is NOT applied to the current project. It is a self-contained write-up of problems and recommendations for the SoloFlow plugin itself, meant to be passed back to the SoloFlow maintainer (the user, in the SoloFlow plugin project).

For each approved E-item:
1. No edits are made — this bucket is informational only.

After all E-items are reviewed, write the approved items to `.soloflow/archive/solutions/SPRINT-{NNN}/SOLOFLOW-FEEDBACK.md` as a standalone document that can be copy-pasted into a SoloFlow project conversation. Commit with `docs({sprint}): archive soloflow tester feedback`.

If no E-items exist (tester mode off), skip this entirely.

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
  B. Backlog ideas   : {N queued}  / {M proposed}  (IDEA-{first}..IDEA-{last})
  C. CLAUDE.md edits : {N applied} / {M proposed}  ({files touched})
  D. SOL archived    : {N written} / {M proposed}  (SPRINT-{NNN}/SOL-{first}..SOL-{last})
  E. SoloFlow feedback: {N archived} / {M proposed}  (SPRINT-{NNN}/SOLOFLOW-FEEDBACK.md)  {only if tester mode}

Rejected : {N} (preserved in archive/compound/SPRINT-{NNN}-proposal.md)
Findings : archived → archive/findings/SPRINT-{NNN}-findings.md
```

---

## Notes

- This command mutates the codebase only for approved clean-ups and CLAUDE.md edits. Everything else is additive to `.soloflow/`.
- The compounder agent is read-only except for `COMPOUND-PROPOSAL.md` — it never writes directly to solutions, ideas, or CLAUDE.md.
- Rejected items are preserved in the archived proposal so they can be revisited manually.
