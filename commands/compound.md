---
description: Propose learnings from completed sprint(s) in three buckets (clean-ups, backlog tasks, CLAUDE.md improvements) plus optional SoloFlow self-improvement feedback (tester mode), then apply what the user approves. Batches multiple pending sprints into one merged proposal when --all or multi-select subset is used.
argument-hint: [optional: SPRINT-NNN | --all | --oldest]
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:compound

Phase 6 of the SoloFlow pipeline. Reads done reports, stuck reports, human review notes, and out-of-scope findings queues, then produces a three-bucket proposal for the user to review one bucket at a time. The main agent (you) applies approved items directly for clean-ups and CLAUDE.md edits, and spawns the task-refiner for backlog tasks.

**Batching.** When two or more sprints are pending, `--all` (or a multi-select picker) batches them into ONE compounder invocation → ONE merged proposal (`SPRINT-{MIN}-{MAX}-proposal.md`) → ONE review flow → ONE apply pass. Each sprint's findings file still archives individually. Single-sprint runs are unchanged (no span, no batching logic engages).

Target: **$ARGUMENTS** (optional — sprint selector). Accepted values:
- `SPRINT-NNN` — compound that specific sprint (single-sprint path)
- `--all` — batch every pending sprint into one merged proposal
- `--oldest` — silently pick the oldest pending sprint (single-sprint path)
- empty — single pending sprint auto-selected; multi-select picker when two or more exist (user can pick a subset, all, or type free-text IDs for unusual subsets)

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

## Step 1: Identify sprint(s) and build the batch

Run the discovery script once:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/compound/batch-select.js" detect-pending
```

Returns `{ pending, pending_findings_paths, coverage_numeric, picker_threshold }`. Name the returned `pending` array `PENDING` and the returned `picker_threshold` value `PICKER_THRESHOLD` below.

### 1a. (discovery done by the script above)

The script implements this procedure:
1. Globs `.soloflow/active/findings/SPRINT-*-findings.md`.
2. Builds a coverage set from `.soloflow/archive/compound/*-proposal.md`: a sprint `NNN` is covered iff an archived basename is either `SPRINT-NNN-proposal.md` (exact) or `SPRINT-AAA-BBB-proposal.md` with `min(AAA,BBB) <= NNN <= max(AAA,BBB)` (span range, inclusive).
3. Drops covered sprints and sorts the remainder by numeric suffix ascending.

The frontmatter `sprints:` array is the canonical membership truth for non-contiguous batches — the script falls back to filename-range coverage (correct for every contiguous case). If you need the array form, read the proposal frontmatter directly.

### 1b. Interpret `$ARGUMENTS` and resolve `BATCH_SPRINTS`

1. **`$ARGUMENTS == SPRINT-NNN`** → `BATCH_SPRINTS = [SPRINT-NNN]`. If `PENDING` is non-empty and doesn't include this sprint, still allow (user may be re-running against legacy state). Proceed to the idempotency guard.
2. **`$ARGUMENTS == --all`** → if `PENDING` is empty, report "No pending sprints to compound." and stop. Otherwise `BATCH_SPRINTS = PENDING`.
3. **`$ARGUMENTS == --oldest`** → if `PENDING` is empty, report and stop. Otherwise `BATCH_SPRINTS = [PENDING[0]]`.
4. **`$ARGUMENTS` empty:**
   - `PENDING` length 0 → report "No pending sprints to compound." and stop.
   - `PENDING` length 1 → `BATCH_SPRINTS = PENDING` silently.
   - `PENDING` length ≥ `PICKER_THRESHOLD` → **multi-select picker**. Use **AskUserQuestion** with `multiSelect: true`. Options (capped at 4 per tool contract):
     - When `|PENDING| <= 3`: one option per pending sprint (label: `SPRINT-NNN ({pending_count} findings)`), plus a final "Compound all pending ({N})" option — everything fits.
     - When `|PENDING| >= 4`: one "Compound all pending ({N})" option, plus the first 3 pending sprints as individual options. Users who need an unusual subset (e.g., a later sprint only, or a mix excluding the first 3) use the automatic **Other** free-text escape and type a comma-separated list like `SPRINT-003, SPRINT-005`.
     
     **Post-processing the selection:**
     - If the set includes "Compound all pending" → `BATCH_SPRINTS = PENDING` (overrides any individual checks).
     - Else if one or more specific sprints are checked → `BATCH_SPRINTS = checked set`, preserved in numeric-ascending order.
     - Else if the user provided free-text via Other → parse IDs, validate each against `PENDING`. Unknown or already-compounded IDs → re-prompt once, noting the bad IDs in the question text. Empty or all-invalid selection → re-prompt.
     - If `BATCH_SPRINTS` resolves to a single element, the single-sprint path kicks in naturally (no span naming, no `[SPRINT-NNN]` row prefixes, commit scopes unchanged).

### 1c–1f. Resolve span + inputs + idempotency + stale-draft safety

Once `BATCH_SPRINTS` is resolved from 1b, run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/compound/batch-select.js" build-inputs \
    --sprints SPRINT-NNN,SPRINT-MMM
```

The script returns:
- `span_label` → `SPAN_LABEL` (e.g. `SPRINT-001` for single, `SPRINT-001-003` for non-contiguous)
- `proposal_basename` → `PROPOSAL_BASENAME`
- `active_draft_path` / `archive_destination` — target paths under `.soloflow/active/compound/` and `.soloflow/archive/compound/`
- `inputs` — per-sprint `{ sprint_id, findings_path, done_reports, stuck_reports }` (routing by done/stuck-report frontmatter `sprint:` field; reports for sprints not in the batch are excluded)
- `review_queue_path` — shared across sprints, passed ONCE to the compounder
- `idempotency_violations` — sprint IDs already covered by an archived proposal. If non-empty, report them and stop.
- `conflicts` — active drafts whose frontmatter already names any batch member. If non-empty, stop with: `"Stale compound draft at {path} covers SPRINT-NNN. Resolve it first (re-run /soloflow:compound against the draft, run sprint-closer to archive it, or delete it manually) before continuing."` Do NOT silently overwrite.

**Legacy findings migration.** If a sprint's per-sprint findings file doesn't exist, the script falls back to `.soloflow/active/findings.md` if present — that's the one-shot legacy migration path. After Step 5 archives the proposal, delete the legacy file.

If every sprint's done/stuck inputs are empty AND its findings file has no entries, report "No completed tasks or findings to learn from." and stop.

## Step 2: Spawn the compounder

1. **Ensure** `.soloflow/active/compound/` exists (`mkdir -p`). The draft will be written there as `{PROPOSAL_BASENAME}` (single-sprint or span-named).
2. **Resolve `tester` flag.** Check `.soloflow/config.json` first, then `config/defaults.yaml` (via `${CLAUDE_PLUGIN_ROOT}`). If `tester: true`, pass `tester: true` to the compounder so it produces bucket D (SoloFlow improvements). Otherwise omit it.
3. Spawn the **compounder** agent via the Agent tool with:
   - `sprints: BATCH_SPRINTS` (the full array) and `span_label: SPAN_LABEL`.
   - The `inputs` list from Step 1f (per-sprint findings/done/stuck paths). **Pass every path verbatim, one per line.** Do not abbreviate with range shorthand such as `TASK-132..TASK-143-done.md`; do not replace a list with a glob pattern; do not paraphrase as "all 12 done reports". `batch-select.js build-inputs` already enumerated the exact paths — copy them into the prompt as-is. Range shorthand is not a filesystem path, and the compounder treats non-existent paths as an input error.
   - `.soloflow/human-review-queue.md` path (shared).
   - If tester mode is on: `tester: true`.
   - Instruction: *"Triage across ALL sprints' inputs together. Dedupe cross-sprint findings into a single item; set `Source-Sprint:` to the comma-joined sprint list for deduped items. Number items globally across the batch (A1..An, B1..Bm, C1..Cp, D1..Dq). Write `.soloflow/active/compound/{PROPOSAL_BASENAME}` with frontmatter `sprints: [...]` (ascending array), `span_label: {SPAN_LABEL}`, and every item carrying `**Source-Sprint:**`. Route each C-item to the correct target file — rules/constraints go to CLAUDE.md, code patterns go to CODE-PATTERNS.md. {If tester: Also produce bucket D (SoloFlow improvements).} Do not apply anything. Cite concrete evidence for every item."*
4. Wait for the compounder to finish.
   - If the compounder reports **CONTEXT_LIMIT**: read the `### Handoff` section. If a partial `active/compound/{PROPOSAL_BASENAME}` was written, read it. Spawn a **fresh compounder** with the same `sprints` + `span_label`, the `sprints_remaining` subset (and their inputs), plus the partial proposal content. The fresh compounder resumes from where the previous one stopped. Cap at resolved `limits.context_limit_respawn_max`.
   - Read the resulting `active/compound/{PROPOSAL_BASENAME}`.

## Step 2.5: Pre-review Bucket C (claude-md-reviewer)

Runs before the user sees any options, so the C-bucket presented in Step 3 is already tightened.

1. **Resolve `compound.claude_md_reviewer.enabled`** per the three-tier recipe (fallback: `true`). If `false`, skip this step entirely and carry raw C-items into Step 3.
2. Parse Bucket C from `active/compound/{PROPOSAL_BASENAME}`. If the bucket is empty (`_No items._`) or has zero entries, skip.
3. Spawn the **claude-md-reviewer** agent with:
   - The full list of C-items (all of them — not user-filtered), each carrying its `**Source-Sprint:**` field verbatim.
   - The target `SPAN_LABEL` (used for commit message context).
   - Instruction: *"Review every proposed CLAUDE.md / CODE-PATTERNS.md improvement against the existing codebase and CLAUDE.md files. Produce tightly scoped diffs at the lowest appropriate directory level. Reject redundant, stale, or overly broad proposals with a reason code. When an item mixes rule content and pattern content, SPLIT it into two ready items (one for CLAUDE.md, one for CODE-PATTERNS.md) both tagged source_item: C{n}. Preserve each item's Source-Sprint field verbatim — copy it into both halves of a split."*
   - Handle **CONTEXT_LIMIT** respawns identically to Step 2 (capped at resolved `limits.context_limit_respawn_max`).
4. **Rewrite Bucket C in the proposal file** using the reviewer's output:
   - **Ready items:** replace the original item's content with the reviewer's refined diff + `**Status:** ready` tag. Preserve the item's title and source citation. For split items, insert both halves contiguously and keep both with their `source_item: C{n}` tag.
   - **Rejected items:** flatten to an info-only block with heading `### C{n}. {title} [dropped — {reason}]` and a single `**Reason:** {one sentence}` line. Do NOT include the original diff.
   - Re-number the **ready items** sequentially (`C1..Cm`) so "Approve some" can reference them unambiguously. Keep the original `source_item` tag inside each item so the audit trail is preserved. Rejected items keep their `[dropped]` prefix and do not consume an index.
5. If every C-item was rejected, note it for Step 3 (present dropped list info-only; skip the approve/reject prompt for C entirely).

## Step 2.6: Skeptic review (compound-skeptic)

Adds per-item IMPLEMENT / DONT_IMPLEMENT verdicts before the user sees options, giving the user an informed "accept skeptic's recommendations" shortcut in Step 3.

1. **Resolve `compound.skeptic.enabled`** per the three-tier recipe (fallback: `true`). If `false`, skip this step entirely — Step 3 will omit the "Accept skeptic's recommendations" option.
   - Also resolve `compound.skeptic.auto_accept_verdicts` per the three-tier recipe (fallback: `false`). Store as `AUTO_ACCEPT_VERDICTS`. When `true` AND the skeptic reaches `REPORTED` in this step, Step 3 will auto-apply the verdicts for buckets A/B/C without prompting. Bucket D is excluded from auto-accept and always prompts. If `skeptic.enabled` is `false`, `AUTO_ACCEPT_VERDICTS` has no effect (no verdicts exist to accept).
2. If every bucket is empty (`_No items._` in A, B, C, and D or D absent), skip — there's nothing to verdict.
3. Spawn the **compound-skeptic** agent with:
   - The target `SPAN_LABEL`.
   - The absolute path to `active/compound/{PROPOSAL_BASENAME}`.
   - (Optional) paths to each sprint's findings file and done reports for evidence.
   - Instruction: *"Walk every live item (skip `[dropped]`). Run 2–4 read-only checks per item. Insert a `### Skeptic Verdict` block under each with verdict, confidence, one-paragraph cited reasoning, and an optional counterfactual. Default to DONT_IMPLEMENT only when you have concrete evidence. Do not touch any item's Source-Sprint field."*
4. Handle **CONTEXT_LIMIT** respawns identically to Steps 2 and 2.5 (capped at resolved `limits.context_limit_respawn_max`). Preserve the skeptic's partial verdicts — a fresh skeptic picks up where the last one left off using the proposal file's existing Skeptic Verdict blocks as the record.
5. After the skeptic returns `REPORTED`, re-read the proposal. Note per-bucket counts: `{implement}` / `{dont}` / `{skipped-dropped}` for use in Step 3.

## Step 2.7: Emit scannable summary

This is the final output the user sees **before** the bucket-by-bucket AskUserQuestion flow in Step 3. Its job is to let the user skim every recommendation and its skeptic verdict at a glance, with a link to the full proposal for any item they want to dig into.

1. Re-read the finalized `.soloflow/active/compound/{PROPOSAL_BASENAME}` (it now has item Summary + Source-Sprint fields from the compounder, ready/dropped C-items from Step 2.5, and skeptic verdict blocks from Step 2.6 where applicable).
2. For every non-dropped item in every non-empty bucket, extract: `title`, `Summary`, `Source-Sprint`, `Skeptic Verdict` (IMPLEMENT | DONT_IMPLEMENT), `Skeptic Confidence`, and the one-sentence `Skeptic Reasoning`.
3. For every dropped C-item (from Step 2.5), extract: `original title`, `Summary`, `Source-Sprint`, reviewer `Reason` and reason code. Dropped items carry no skeptic verdict.
4. Compose the block below and print it **inline as a standalone message** (not via AskUserQuestion, and not embedded in the Step 3 per-bucket prompt — it is a pre-read, not a question payload). Then proceed immediately to Step 3.

### Emitted block format

```
## Compound Proposal — {SPAN_LABEL} (scannable)

Full proposal: [active/compound/{PROPOSAL_BASENAME}]({absolute path on disk})

### A. Clean-ups ({live} items)
- **A1. [{Source-Sprint}] {title}** — {Summary} _Skeptic: IMPLEMENT ({conf})_ — {Reasoning}.
- **A2. [{Source-Sprint}] {title}** — {Summary} _Skeptic: DONT_IMPLEMENT ({conf})_ — {Reasoning}.

### B. Backlog tasks ({live} items)
- **B1. [{Source-Sprint}] {title}** — {Summary} _Skeptic: IMPLEMENT ({conf})_ — {Reasoning}.

### C. CLAUDE.md / CODE-PATTERNS.md ({ready} ready, {dropped} dropped)
- **C1. [{Source-Sprint}] {title}** — {Summary} _Skeptic: IMPLEMENT ({conf})_ — {Reasoning}.
- **[dropped — {reason code}] [{Source-Sprint}] {original title}** — {Summary} _Reviewer: {one-sentence reason}_.

### D. SoloFlow improvements ({live} items)     # only in tester mode
- **D1. [{Source-Sprint}] {title}** — {Summary} _Skeptic: IMPLEMENT ({conf})_ — {Reasoning}.
```

### Rules for the block

- **Source-Sprint prefix:** render `[{Source-Sprint}]` in front of each item's title only when `|BATCH_SPRINTS| >= 2`. For single-sprint runs, omit the prefix entirely (UX is identical to today). For deduped items (multi-sprint Source-Sprint), render the comma-joined list, e.g., `[SPRINT-001, SPRINT-003]`.
- **Empty buckets:** omit the entire `### {letter}. …` section. Do not print `_No items._` in the scannable summary.
- **All buckets empty:** print `No items to review — proposal is empty.` as the body and continue. Step 3 will skip naturally.
- **Dropped C-items:** render with the `[dropped — {reason code}]` prefix and the reviewer's one-sentence reason in place of a skeptic verdict. They are not indexable (consistent with Step 3's Bucket C rule) but the line keeps the user informed.
- **Tester mode off:** omit the D section entirely.
- **Tester mode on:** render Bucket D the same way. Step 3's Bucket D handling (full inline write-up before the Approve/Edit/Reject prompt) is unchanged — the scannable row is a pointer, not a replacement.
- **Skeptic disabled or did not run (Step 2.6 skipped or failed):** omit the `_Skeptic: … — …_` tail on every row; keep `**A1. [{Source-Sprint}] {title}** — {Summary}` only (with the prefix still governed by the multi-sprint rule). Dropped C-items are unaffected.
- The `[{absolute path on disk}]` link target must be the absolute filesystem path to the proposal so the user can open it directly.

## Step 3: Present proposal and collect approvals — one bucket at a time

The scannable summary from Step 2.7 is already on screen — the user has read the per-item Summary and skeptic verdict for every bucket before this step fires. Do not re-emit that summary here. The per-bucket AskUserQuestion still embeds its own compact title list per the cutoff rule below.

### Auto-accept short-circuit (`AUTO_ACCEPT_VERDICTS`)

If `AUTO_ACCEPT_VERDICTS` (resolved in Step 2.6) is `true` AND the skeptic reached `REPORTED`, **buckets A, B, and C bypass the AskUserQuestion flow below**. For each non-empty A/B/C bucket with at least one verdict, apply the same semantics as the "Accept skeptic's recommendations" option: every item with `Skeptic Verdict: IMPLEMENT` is accepted, every item with `Skeptic Verdict: DONT_IMPLEMENT` is rejected. Print one inline summary line per bucket and record the split for Step 6:

```
Bucket {letter} — auto-accepted skeptic ({N IMPLEMENT applied, M DONT_IMPLEMENT rejected})
```

Edge cases:
- Bucket has zero verdicts (e.g., every C-item was dropped in Step 2.5): the auto-accept gate (`bucket has ≥1 verdict`) excludes it. Fall through to the normal "skip empty bucket" handling — no prompt, no auto-accept line.
- Bucket has only `IMPLEMENT` verdicts: equivalent to "Approve all". Print the one-liner with `(N IMPLEMENT applied, 0 DONT_IMPLEMENT rejected)`.
- Bucket has only `DONT_IMPLEMENT` verdicts: equivalent to "Reject all". Print the one-liner with `(0 IMPLEMENT applied, N DONT_IMPLEMENT rejected)`. Step 6's row will show `0 applied / 0 IMPLEMENT / N proposed`.
- `compound.claude_md_reviewer.pre_review_feedback_rounds` has no effect when auto-accept is on, because the Bucket C "Give feedback" loop is unreachable.

**Bucket D is explicitly excluded from auto-accept.** It always uses the inline write-up + Archive/Edit/Reject flow described below, regardless of `AUTO_ACCEPT_VERDICTS`. Bucket D is SoloFlow self-improvement feedback meant for a maintainer to read — auto-archiving without human review would defeat its purpose.

If `AUTO_ACCEPT_VERDICTS` is `false` OR the skeptic did not run, all buckets follow the normal per-bucket AskUserQuestion flow below.

### Per-bucket AskUserQuestion flow

Walk through each bucket sequentially. For each non-empty bucket:

1. Build a compact summary: item count and one-line title per item. When `|BATCH_SPRINTS| >= 2`, prefix each title with its `[Source-Sprint]` (same rule as Step 2.7). Single-sprint batches render titles without the prefix.
2. Use **AskUserQuestion** with the summary **embedded in the question text** (not printed separately before the call — text printed before AskUserQuestion gets visually cut off by the question UI). Format the question as:

   Multi-sprint: `Bucket {letter} — {name} ({N} items): {[Source-Sprint] title}, {[Source-Sprint] title}, ... Approve?`

   Single-sprint: `Bucket {letter} — {name} ({N} items): {title}, {title}, ... Approve?`

   Options:
   - **Approve all** — accept every item in this bucket
   - **Approve some** — user lists which items to keep (e.g., `A1, A3`); anything unlisted is rejected
   - **Reject all** — skip this bucket entirely
   - **Accept skeptic's recommendations** — accept every item the skeptic marked `IMPLEMENT`; reject every item marked `DONT_IMPLEMENT`. **Only include this option** when the skeptic ran (Step 2.6 was enabled and reached REPORTED) AND the bucket has at least one `DONT_IMPLEMENT` verdict. Omit it when every verdict is `IMPLEMENT` (in that case it degenerates into "Approve all") or when the skeptic was disabled / failed.
   - **Give feedback** — user provides notes; re-run the compounder for this bucket only with the feedback appended, then re-present
3. Record the per-bucket decisions before moving to the next bucket. If the user picked "Accept skeptic's recommendations", record the split explicitly so Step 6's report can call out `{N applied (skeptic IMPLEMENT) / M proposed}`.

**Bucket C presentation (after claude-md-reviewer pre-review):**

Bucket C's summary has two parts:
- Count of ready items — *approvable*. Use `Cn` indices from the renumbered list. Apply the multi-sprint `[Source-Sprint]` prefix to approvable titles when batching.
- Count of dropped items — *info-only*, with their reason codes. Shown as `[dropped — reason]`. Not indexable by "Approve some".

Question format: `Bucket C — CLAUDE.md / CODE-PATTERNS.md improvements: {m} approvable, {k} dropped by reviewer ({reason codes}). {approvable titles with [Source-Sprint] prefix when batching, comma-separated}. Approve?`

- "Approve all" accepts every ready item.
- "Approve some" lists ready indices only (e.g., `C1, C3`); unlisted ready items are rejected.
- If every C-item was dropped (`m == 0`), skip the AskUserQuestion entirely — just print the dropped list as info and continue to the next bucket.
- **"Give feedback" on Bucket C:** re-run the compounder with the feedback appended. The re-run passes the FULL `inputs` list (all of `BATCH_SPRINTS`) so the compounder rebuilds Bucket C end-to-end with cross-sprint context intact. Then re-run Step 2.5 (claude-md-reviewer) before re-presenting. Cap the loop at resolved `compound.claude_md_reviewer.pre_review_feedback_rounds` (fallback: `2`). When the cap is hit, print `Feedback budget exhausted — using last reviewer output as final.` and treat the current state of Bucket C as the final presentation. Feedback on buckets A/B/D does not re-trigger Step 2.5, but it DOES re-run the compounder against the full `inputs` list.

**Bucket D exception (SoloFlow improvements):** Do not use the standard approve/reject flow, and do not honor `AUTO_ACCEPT_VERDICTS` — Bucket D always prompts the user (its write-up is SoloFlow self-improvement feedback that must reach a maintainer). Instead:
1. Print the full feedback write-up inline so the user can read and copy it directly. When batching, each D-item's title in the write-up carries its `[Source-Sprint]` prefix so maintainers can correlate recommendations back to the originating sprint(s).
2. If the skeptic ran and emitted any `DONT_IMPLEMENT` verdicts on D-items, print a one-line summary first: `Skeptic marked {N} of {M} recommendations IMPLEMENT.` If every D-item is `IMPLEMENT`, omit the summary.
3. Use **AskUserQuestion**: `SoloFlow feedback ready. Archive and continue?` with options:
   - **Approve** — archive as-is to `{SPAN_LABEL}-feedback.md` (single-sprint → `SPRINT-NNN-feedback.md`; merged batch → `SPRINT-{MIN}-{MAX}-feedback.md`). If any D-item is `DONT_IMPLEMENT`, silently strip those items from the archived write-up and include a final `skeptic_stripped:` section listing their titles + reasoning so the audit trail is preserved.
   - **Edit** — user provides edits; revise the write-up, re-print, and re-ask
   - **Reject** — discard, skip archiving
4. If approved, write to `.soloflow/archive/compound/{SPAN_LABEL}-feedback.md` and commit. No further action needed in Step 4.

If a bucket is empty (`_No items._`), skip it silently — do not present an empty picker.

After all buckets have been reviewed, print a one-line summary of accepted/rejected counts across all buckets, then proceed to Step 4.

## Step 4: Apply approved items

Use atomic commits per the global atomic-commits rule.

**Commit scope rule.** Each item's commit `scope` is derived from its `**Source-Sprint:**` field:
- Single source sprint → use it directly (e.g., `chore(SPRINT-002): {title}`).
- Multi-source (dedup item, comma-joined Source-Sprint) → scope = the **earliest** source sprint by numeric suffix; include a body line `Also surfaced by: SPRINT-NNN[, SPRINT-MMM]` naming the other contributing sprints. This keeps conventional-commit parsers happy while preserving the full audit trail in the commit body.

### Bucket A — clean-ups
For each approved A-item:
1. Make the edits described in the proposal using `Edit` / `Write`.
2. Commit with `chore({scope}): {title}` per the Commit scope rule above, including only the files touched by this item. For multi-source items, add the `Also surfaced by:` body line.
3. Do not batch multiple A-items into one commit.

### Bucket B — backlog tasks (refine into plans)
For the set of approved B-items, produce execution-ready task plans by spawning the **task-refiner** agent:

1. Compute the starting task counter from the filesystem (see "ID allocation" in the project `CLAUDE.md`).
2. Discover existing epics (glob `.soloflow/active/plans/*/EPIC-*.md`).
3. Assemble the approved B-items into a single brief: for each item include its title, **Source-Sprint**, problem, proposed direction, scope, and source. Prefix with:
   - Single-sprint batch: *"These work items were surfaced by the compounder during SPRINT-{NNN}. Refine each into an execution-ready task plan."*
   - Multi-sprint batch: *"These work items were surfaced by the compounder during {comma-separated BATCH_SPRINTS}. Each item below carries its own Source-Sprint field — use it to pick epic/scope if applicable. Refine each into an execution-ready task plan."*
4. Spawn the **task-refiner** agent via the Agent tool with the brief, starting task counter, and existing epics — same interface as `/soloflow:planner` Step 2.
5. Capture the output. Parse into individual plan files and any new EPIC-{slug}.md blocks.
6. Write each plan file to `.soloflow/active/plans/` (respecting epic subfolders), using `noclobber`/`wx` semantics. Retry on collision. Each plan's frontmatter MUST carry `status: ready` — that frontmatter IS the queue entry; no separate queue file to update.
7. Commit the batch as one commit:
   - Single-sprint: `feat(SPRINT-{NNN}): plan TASK-{NNN}..TASK-{MMM} from compound` (unchanged).
   - Multi-sprint: `feat(SPRINT-{MIN}..{MAX}): plan TASK-{NNN}..TASK-{MMM} from compound` including all plan files.

### Bucket C — CLAUDE.md / CODE-PATTERNS.md improvements

The diffs are already tightened by Step 2.5. No re-spawn of claude-md-reviewer here.

For each approved C-item (already `ready` in the proposal):
1. Read the item's `**Target file:**` and `**Diff:**`.
2. Apply the diff using `Edit` (or `Write` if the target file does not exist — applies when creating a new scoped CLAUDE.md or CODE-PATTERNS.md).
3. Commit with `docs({scope}): {title}` per the Commit scope rule above (per-item; multi-source items get the `Also surfaced by:` body line).

Dropped items (from Step 2.5) are never applied — they stay in the archived proposal as an audit trail only.

### Bucket D — SoloFlow improvements (tester mode only)

Bucket D is handled entirely in Step 3 (write-up presented inline, feedback file archived). No action needed here. If no D-items exist (tester mode off), skip entirely.

---

If any application step fails (e.g., a diff doesn't apply cleanly because the target file changed), stop that item, log the error to the summary, and continue with the rest. Never roll back committed items.

## Step 5: Archive & sweep

1. For **each** sprint in `BATCH_SPRINTS`, move `.soloflow/active/findings/SPRINT-NNN-findings.md` → `.soloflow/archive/findings/SPRINT-NNN-findings.md`. Each findings file archives individually. (Do NOT recreate an empty file — the next sprint's findings file is created by sprint-initiator, not here.)
2. Move `.soloflow/active/compound/{PROPOSAL_BASENAME}` → `.soloflow/archive/compound/{PROPOSAL_BASENAME}` (preserves rejected items for later reference). Single-sprint batch → `SPRINT-NNN-proposal.md`; merged batch → `SPRINT-{MIN}-{MAX}-proposal.md`.
3. **Legacy findings cleanup:** if this run used a legacy `.soloflow/active/findings.md` via the Step 1 migration branch, delete the legacy file now (its contents were captured by whichever sprint's archived findings file absorbed it).
4. Commit the archive:
   - Single-sprint: `chore(SPRINT-NNN): archive findings + compound proposal` (unchanged).
   - Multi-sprint: `chore(SPRINT-{MIN}..{MAX}): archive merged compound + findings`.
   - Stage list is driven by the actual moves performed (per-sprint findings additions/deletions + the single proposal add/delete + any legacy findings deletion). Do not hardcode the stage list to a single-sprint template.

## Step 6: Report

### Single-sprint batch (`|BATCH_SPRINTS| == 1`):

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

### Multi-sprint batch (`|BATCH_SPRINTS| >= 2`):

```
Compound complete for {SPAN_LABEL} ({N} sprints: {comma-joined BATCH_SPRINTS}).

Applied (across all sprints):
  A. Clean-ups       : {N applied} / {skeptic_implement} IMPLEMENT / {M proposed}  (commits: {hashes})
  B. Backlog tasks   : {N planned} / {skeptic_implement} / {M proposed}  (TASK-{first}..TASK-{last})
  C. CLAUDE.md edits : {N applied} / {skeptic_implement} / {M proposed}  ({files touched})
  D. SoloFlow feedback: {N archived} / {skeptic_implement} / {M proposed}  ({SPAN_LABEL}-feedback.md)  {only if tester mode}

By sprint:
  SPRINT-NNN: A:{x/y} B:{x/y} C:{x/y}{ D:{x/y} only if tester}
  ...

Rejected : {N} (preserved in archive/compound/{PROPOSAL_BASENAME})
Findings : archived → {comma-joined archive/findings/SPRINT-NNN-findings.md paths}
```

The `{skeptic_implement}` column reflects how many items the skeptic endorsed per bucket. Omit the column entirely (just show `{N applied} / {M proposed}`) if the skeptic was disabled or did not run.

When at least one A/B/C bucket fired through the auto-accept short-circuit (Step 3, `AUTO_ACCEPT_VERDICTS: true`), prepend a single-line header above the `Applied:` block: `(auto-accepted skeptic verdicts — no per-bucket review)`. Omit it when no bucket auto-accepted (e.g., flag was off, skeptic disabled, or every bucket was empty / fell through the gate).

The **By sprint** block attributes each bucket's applied/proposed counts back to the contributing sprint via each item's `**Source-Sprint:**`. Dedup items (multi-sprint Source-Sprint) count toward every sprint they cite.

---

## Notes

- This command mutates the codebase for approved clean-ups and CLAUDE.md edits. Bucket B spawns the task-refiner to produce plans.
- The compounder agent is read-only except for its own proposal draft (`active/compound/{PROPOSAL_BASENAME}` — single-sprint or span-named) — it never writes directly to plans or CLAUDE.md.
- The claude-md-reviewer agent runs as a pre-review in Step 2.5, tightening Bucket C before the user sees options. It can only edit the proposal file to insert `[reviewer: ready]` / `[dropped — reason]` markers and refined diffs, preserving each item's Source-Sprint field.
- The compound-skeptic agent runs in Step 2.6 (after claude-md-reviewer), adding per-item IMPLEMENT / DONT_IMPLEMENT verdicts to non-dropped items. It enables the "Accept skeptic's recommendations" option. Toggle via `compound.skeptic.enabled`. It never touches an item's Source-Sprint field.
- The `compound.skeptic.auto_accept_verdicts` toggle (default `false`) makes Step 3 non-interactive for buckets A/B/C when the skeptic ran: each is auto-resolved using the same semantics as "Accept skeptic's recommendations". Bucket D always prompts — its write-up is SoloFlow self-improvement feedback that must reach a maintainer. Pair with `/soloflow:sprint-and-compound` for a pipeline whose only remaining prompts are sprint setup, Bucket D review (tester mode only), and the final merge choice.
- Step 2.7 emits a single scannable summary (one line per item: `[Source-Sprint]` prefix when batching + title + Summary + skeptic verdict + reasoning) with a link to the full proposal file. It fires once, just before Step 3's bucket-by-bucket flow, so the user can triage the whole batch at a glance.
- Rejected items are preserved in the archived proposal so they can be revisited manually.
- **Batching.** Multiple sprints can await compound simultaneously. When two or more sprints are in the batch (`--all` or a multi-select picker subset), this command runs ONCE over the merged set — one compounder invocation with cross-sprint dedup, one review flow, one apply pass, one archive. Each per-sprint findings file archives individually. Per-item commits scope to each item's originating sprint (dedup items scope to the earliest source sprint with an `Also surfaced by:` body line).

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
