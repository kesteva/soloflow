---
description: Turn an approved idea into execution-ready task plans
argument-hint: <IDEA-NNN>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:planner

Phase 2 of the SoloFlow pipeline. Reads an approved idea (and its research report, if present) and produces execution-ready task plans. Populates the backlog.

The target idea is: **$ARGUMENTS**

---

## Model + limits resolution

Run once:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" \
    --key models.task_refiner --key models.task_decomposer \
    --key limits.context_limit_respawn_max \
    --key parallelism.task_refiner_parallel \
    --fallback opus --fallback sonnet --fallback 3 --fallback true
```

Line 1: task-refiner model. Line 2: task-decomposer model. Line 3: context-limit respawn cap. Line 4: parallelism toggle (`true`/`false`).

## Step 0: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Load the Idea

1. Parse `$ARGUMENTS` as an idea ID (e.g., `IDEA-001`). If empty or malformed, list `.soloflow/active/ideas/` and use the **AskUserQuestion** tool to let the user pick which idea to refine — pass the discovered idea IDs as options rather than printing them as prose.
2. Read `.soloflow/active/ideas/IDEA-{NNN}.md`. If missing, report the error and stop.
3. Check for `.soloflow/active/research/IDEA-{NNN}-research.md` — if present, it will be passed to the refiner.
4. Compute the starting task counter via `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/next-ids.js" --kind task` — this globs every TASK file location and returns the next zero-padded ID.
5. Discover existing epics: glob `.soloflow/active/plans/*/EPIC-*.md` and collect each epic slug (parent folder name) and `EPIC-{slug}.md` contents. Pass these to the refiner so it can reuse epics instead of duplicating them.

## Step 2: Refine

Two paths: **parallel** (decomposer + N detailers) when `parallelism.task_refiner_parallel` resolves to `true`, **legacy** (single whole-IDEA refiner call) when `false`. Pick once based on the resolved value.

### Step 2 — legacy path (parallelism disabled)

Skip this whole subsection if `parallelism.task_refiner_parallel === true`. When disabled:

1. Spawn the **task-refiner** agent via the Agent tool with:
   - The approved idea file content
   - If a research report exists, include it with: "A research report is provided below. Use it to inform your approach selection, library choices, and to resolve open questions before doing your own research."
   - The starting task counter
   - The list of existing epics discovered in Step 1.5 (slug + `EPIC-{slug}.md` contents). Instruct: "Reuse these existing epics when a task fits their objective. Propose new epic slugs only when 2+ tasks share a coherent objective. Leave `epic` null for orphan tasks."
   - Instruction: "Refine this idea into execution-ready plans. Start task numbering at TASK-{NNN}. Output each plan file's content clearly separated. For any new epic slugs you introduce, also output an EPIC-{slug}.md block."
2. Capture the refiner's output.
   - If the task-refiner reports **CONTEXT_LIMIT**: read the `### Handoff` section to get plans produced so far. Write the completed plans to disk (same as normal flow). Spawn a **fresh task-refiner** with: the original idea, "Continue refinement from previous refiner's handoff. These tasks are already planned: {list}. Start numbering at TASK-{next}.", the handoff content, and the updated starting counter. Merge outputs. Cap at resolved `limits.context_limit_respawn_max` context-limit respawns; after that, proceed with whatever plans exist.
3. Parse the output into individual plan files and any new EPIC-{slug}.md blocks. Before parsing each plan block, pipe its raw text through the post-fence sanitizer:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/refiner/sanitize-plan.js" --task-id TASK-{NNN} --input <raw-plan-tmpfile>
   ```
   Use the returned `body` as the plan content to parse and write. If `stripped_bytes > 0`, record the count and the task ID — surface it in Step 3 as an advisory: "Sanitized N bytes of post-fence debug output from TASK-{NNN}'s plan." This is non-blocking; proceed regardless. Skip ahead to step 3a (parity gates) below.

### Step 2 — parallel path (default)

1. **Decompose.** Spawn the **task-decomposer** agent via the Agent tool (`subagent_type: "task-decomposer"`, `model: <resolved task_decomposer>`) with:
   - The approved idea file content
   - The research report (if present), prefaced with: "A research report is provided below. Use it to inform task boundaries, library choices, and how slices group into tasks."
   - The list of existing epics from Step 1.5 (slug + `EPIC-{slug}.md` contents). Instruct: "Reuse these existing epics when a slot fits their objective; propose a new slug only when 2+ slots share an objective. Leave `epic: null` for orphans."
   - Instruction: "Decompose this idea into a coarse task skeleton per your output schema. Use slot IDs T1..TN — the orchestrator will allocate real TASK IDs. Cross-task invariants (depends_on DAG, files_owned_hint disjointness across siblings, epic decisions) are your responsibility."
2. **Parse the skeleton.** The decomposer's output is a single fenced JSON block with `tasks[]`, `new_epics[]`, `scope_drops[]`. `JSON.parse` it. On parse failure, retry the decomposer once with the error message; on second failure, fall back to the legacy path for this run and surface a warning in Step 3.
3. **Validate the skeleton (cheap pre-checks).** Before allocating IDs:
   - Each `tasks[].slot` is unique and matches `^T\d+$`.
   - Every `depends_on` entry references a sibling slot.
   - `files_owned_hint` lists are pairwise disjoint across siblings (no path appears as `files_owned_hint` in two slots). On overlap: respawn the decomposer once with a targeted note ("slots TX and TY both claim `<path>` in files_owned_hint — split or merge"). On second failure, surface as a Step 3 warning and proceed (the parity gates 3a/3b will partially recover).
   - Every `epic` value is `null`, an existing slug, or a slug that appears in `new_epics`. Mismatches → respawn once, then warn.
4. **Allocate real TASK-NNN IDs.** Resolve the starting counter from Step 1 step 4. Assign IDs sequentially in `tasks[]` source order: slot `T1` → `TASK-{starting}`, `T2` → `TASK-{starting+1}`, etc. Build a slot→TASK map. Remap each task's `depends_on` from slot IDs to real TASK IDs using the map.
5. **Single-task short-circuit.** If `tasks.length === 1`, skip the parallel fan-out and spawn ONE `task-refiner` in detail mode (next step's prompt shape) for that one task. Otherwise continue.
6. **Detail in parallel.** Issue **one message containing one `Agent` tool call per skeleton task**, identical to the parallel-pipeline pattern in `commands/sprint.md` Step 4.b. Each call:
   - `subagent_type: "task-refiner"`
   - `model: <resolved task_refiner>`
   - Prompt body, in this order:
     ```
     MODE: detail
     TASK_ID: TASK-{NNN}
     TASK_SKELETON: <JSON of this task's slot, with depends_on remapped to real TASK IDs>
     SIBLING_DAG:
       TASK-007 | <title> | <epic> | depends_on=[TASK-008]
       TASK-008 | <title> | <epic> | depends_on=[]
       ...

     # Idea
     <full IDEA file content>

     # Research (if present)
     <research report content, with the same preface as the legacy path>

     # Existing epics (for context — do NOT propose new slugs)
     <slug + EPIC-{slug}.md contents for each>
     ```

   Wait for all calls to return.
7. **Collate detailer outputs.** Each detailer output is one TASK-NNN-plan.md block (frontmatter + body). Before parsing each, pipe the raw text through the post-fence sanitizer to strip telemetry tokens (`agentId:`, `<usage>`, `<input_tokens>`, etc.) and any chain-of-thought prose appended after the closing fence:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/refiner/sanitize-plan.js" --task-id TASK-{NNN} --input <raw-plan-tmpfile>
   ```
   Use the returned `body` as the plan content to parse and write. Aggregate `stripped_bytes` per task; surface the totals in Step 3 as an advisory line ("Sanitized N bytes of post-fence debug output from TASK-{NNN}'s plan."). This is non-blocking — pipeline continues regardless.
   - On any detailer reporting **CONTEXT_LIMIT**: read its `### Handoff`, then respawn a fresh detailer **for that one slot only** (same prompt shape, plus the previous handoff prepended). Cap at resolved `limits.context_limit_respawn_max` per slot. Do not respawn sibling detailers.
   - If a detailer fails entirely (no parseable plan after respawn cap): drop that slot, surface it in Step 3 as `Detailer failed for TASK-{NNN}: <slug>`, and proceed with the rest. The user can re-run after fixing.
8. **Materialize new EPIC files.** For each entry in the decomposer's `new_epics[]`, generate its `EPIC-{slug}.md` body using the schema from `agents/task-refiner.md` Output Format ("originating_ideas" → `[IDEA-{NNN}]`, status `active`, the decomposer's title/objective/scope/success_signal). The detailers do NOT emit EPIC blocks in this path.

After step 7 (or step 5's short-circuit), you have parsed plans + EPIC blocks ready for parity gates 3a/3b below.

### Step 2 — common (both paths): parity gates and write

The legacy path ends here too — `Skip ahead to step 3a (parity gates) below.` lands on this subsection. From this point both paths share identical handling.

3a. **Validate `test_strategy` ↔ `files_owned` parity (deterministic gate).** For each parsed plan, cross-check every `test_strategy.targets[].test_file` against that plan's `files_owned` list:
   - If a target `test_file` is missing from `files_owned`, auto-insert it into `files_owned` before writing the plan to disk.
   - Record each auto-correction (task ID + file path) and surface the list in Step 3 so the user sees what was adjusted.
   - If more than 3 plans required auto-correction in a single refinement run, that is a signal the refiner misunderstood scope — flag it prominently in the Step 3 review and offer the "Request changes" option proactively.

   This gate closes the parity loop at plan-authoring time so the executor never has to trigger a `scope_deviation` finding for this pattern.
3b. **Validate `acceptance_criteria` ↔ `files_owned`/`files_readonly` parity (deterministic gate).** For each parsed plan, scan every `acceptance_criteria[].verification` string for file-path references. Match these patterns (case-sensitive; extract the path argument):
   - `grep ... <path>` (ripgrep or GNU grep; any flags)
   - `cat <path>` / `head <path>` / `tail <path>`
   - `test -e <path>` / `test -f <path>`
   - `python3 -c '...'` invocations that reference `open("<path>")` or `Path("<path>")`
   - a bare path token followed by a contains-check (e.g. `| grep 'X' <path>`, `assert 'Y' in open("<path>").read()`)

   Ignore paths that are clearly command flags (e.g. `-e`, `--file`) or shell metacharacters. For each extracted path, resolve it relative to the repo root and compare against the plan's `files_owned` and `files_readonly` lists:
   - If the path is in `files_owned` → ✓ proceed.
   - If the path is in `files_readonly` → move it to `files_owned` (swap); record the move.
   - If the path is absent from both → insert it into `files_owned`; record the insert.

   Record every auto-correction (task ID + path + `readonly→owned` | `inserted`) and surface the combined list in Step 3 alongside the 3a corrections. Apply the same escalation rule: if 3a + 3b together required auto-correction on more than 3 plans in a single refinement run, flag it prominently and offer "Request changes" proactively — that threshold signals systemic refiner misread.

   Rationale: AC verification that grep-asserts a file's contents after the task implies the executor wrote that file; listing it readonly (or omitting it) produces a guaranteed `scope_deviation` finding. This gate closes the AC-side parity loop at plan-authoring time.
4. Write each plan based on its `epic` frontmatter field:
   - If `epic: <slug>` is set → write to `.soloflow/active/plans/{slug}/TASK-{NNN}-plan.md`, creating the folder if missing.
   - If `epic` is absent or `null` → write to `.soloflow/active/plans/TASK-{NNN}-plan.md` (flat, orphan).
5. For each **new** epic slug the refiner introduced, write its EPIC-{slug}.md body to `.soloflow/active/plans/{slug}/EPIC-{slug}.md`. Do NOT overwrite an existing EPIC-{slug}.md — if one already exists for that slug, leave it alone (optionally append the current idea ID to its `originating_ideas` frontmatter list).
6. Each plan's frontmatter MUST carry `status: ready` and its `depends_on` list — that frontmatter IS the queue entry; no separate queue file to update. IDs are derived from the filesystem — no counter file to update. Write each plan file with `noclobber` / `wx` semantics; if a collision occurs (another parallel planner raced), recompute the next ID for the remaining plans and retry.

## Step 3: Human Checkpoint — Plan Review

Present all plans to the user with:
- Task count and dependency graph
- **Epic groupings**: for each epic slug, list its tasks and (for new epics) its objective. Call out orphan tasks separately. The user may override epic assignments before approval.
- Total estimated complexity
- Decisions made and tradeoffs resolved
- Open questions requiring human input (if any were escalated)
- Any requirements that were dropped with reasoning

Use the **AskUserQuestion** tool to present the choice. Do not list the options as plain markdown bullets — the user should see a structured picker. Ask "How should we proceed with these plans?" with these options:
- **Approve all** — leave all plans with frontmatter `status: ready`
- **Approve subset** — flip unapproved plans to `status: deferred` via `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/set-plan-status.js" deferred TASK-{NNN} ...`
- **Request changes** — re-run the refiner with the user's feedback
- **Reject** — `git rm` the plan files (plans ARE the queue entries; deleting them removes them from the queue)

The tool call blocks until the user responds — do not proceed until it returns.

## Step 3.5: Commit state

After the user responds (approval, subset, or rejection), commit the resulting state via Bash. Stage only the specific paths touched in this run — never `git add .` / `git add -A`.

1. `git add` each plan file written (or whose frontmatter changed) plus any new/modified `EPIC-{slug}.md` files. For rejections, `git rm` the deleted plans.
2. If `git diff --cached --quiet` reports no staged changes, skip (idempotent re-run).
3. Otherwise commit with a message of the form `chore: queue TASK-{NNN}..TASK-{MMM} from IDEA-{NNN}` (adjust for single-task runs or rejection: `chore: reject plans for IDEA-{NNN}`).

Skip this step silently if the project is not inside a git repo or `.soloflow/` is gitignored.

## Step 3.6: Archive the source idea

Once plans are committed (approved or partially approved — not rejected), archive the source idea so it no longer sits in `active/ideas/`:

1. `mkdir -p .soloflow/archive/ideas`
2. Move `.soloflow/active/ideas/IDEA-{NNN}.md` → `.soloflow/archive/ideas/IDEA-{NNN}.md`.
3. If a research report exists at `.soloflow/active/research/IDEA-{NNN}-research.md`, move it to `.soloflow/archive/ideas/IDEA-{NNN}-research.md`.
4. `git add` the moved files (both old and new paths). If `git diff --cached --quiet` reports no changes, skip.
5. Commit with `chore: archive IDEA-{NNN}`.

On rejection (all plans rejected), leave the idea in `active/ideas/` — it may be re-refined later.

Skip silently if not in a git repo or `.soloflow/` is gitignored.

## Step 4: Report

```
Planning complete for IDEA-{NNN}.
- Tasks created: {count} (TASK-{NNN}..TASK-{NNN})
- Ready: {count} | Deferred: {count}

Next step: /soloflow:sprint
```

---

## Notes

- This command does NOT execute any tasks — that's `/soloflow:sprint`.
- Config reference: `executor_retry_max`, `max_sprint_tasks` in `config/defaults.yaml` apply at execution time, not here.

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
