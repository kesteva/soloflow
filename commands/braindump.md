---
description: Quickly capture multiple ideas and tasks from a braindump session
argument-hint: "- idea one\n- idea two\n- fix the login bug"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:braindump

Rapid batch-capture tool. Turns a stream of bullet-point ideas into IDEA and TASK files without spawning agents. Speed is the point — full extraction and grounding happen later via `/soloflow:planner` or `/soloflow:idea-extractor` on individual items.

The user's input is: **$ARGUMENTS**

---

## Step 0: Initialize

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Capture

Branch on whether `$ARGUMENTS` is non-empty.

### Mode A: Inline (arguments provided)

1. Parse `$ARGUMENTS` as a list. Accept any of:
   - Markdown bullets (`- item`)
   - Numbered lists (`1. item`)
   - Newline-separated plain lines
2. Each line/bullet becomes one **raw item**. Strip leading bullets, numbers, and whitespace.
3. Proceed to Step 2.

### Mode B: Interactive (no arguments)

1. Use `AskUserQuestion` with a free-form prompt:
   > "What's on your mind? Type an idea, bug, or task. (Type **done** when finished.)"
2. Collect the response as item 1. If the user typed "done" (case-insensitive, ignoring punctuation) as their first response, report: "No items captured." and stop.
3. Loop: use `AskUserQuestion` each time with:
   > "Next idea? ({N} captured so far. Type **done** to finish.)"
4. When the user types "done", stop collecting.
5. Proceed to Step 2 with the collected items.

## Step 2: Classify

For each raw item, apply heuristic classification. No agent is spawned — the command itself classifies.

### TASK (bounded, actionable change)

Classify as **TASK** if ANY of:
- Starts with an action verb: fix, bug, patch, update, change, rename, remove, delete, move, add (when followed by a specific noun, not a broad feature)
- Contains bug-related language: "is broken", "doesn't work", "typo", "wrong", "missing", "crash", "error"
- Is a clearly bounded single change — roughly fewer than 15 words describing one concrete action

TASK type sub-classification:
- `BUGFIX` if bug-related language is present
- Otherwise omit type (tasks don't carry a type field)

### IDEA (needs extraction/refinement)

Classify as **IDEA** if ANY of:
- Contains feature language: "should", "could", "what if", "explore", "consider", "redesign", "rethink", "add support for", "implement", "build", "create"
- Describes a multi-step initiative or system-level change
- Is ambiguous or open-ended

**Default fallback:** If uncertain, classify as **IDEA** (the safer, more thorough pipeline path).

IDEA type sub-classification:
- `REFACTOR` if "refactor", "restructure", "clean up", "reorganize" appear
- `EXPLORATION` if "explore", "investigate", "research", "spike" appear
- `FEATURE` otherwise (default)

## Step 3: Present Summary

Display the full classified list as a formatted table:

```
## Braindump Summary — {N} items captured

| #  | Item                          | → | Type    |
|----|-------------------------------|---|---------|
| 1  | Add dark mode support         | IDEA  | FEATURE |
| 2  | Fix login redirect loop       | TASK  | BUGFIX  |
| 3  | Refactor auth middleware       | IDEA  | REFACTOR|
| 4  | Rename config key foo→bar     | TASK  | —       |
```

Then use a **single `AskUserQuestion`** with options:

1. **Approve all** — create all files as classified
2. **Reclassify** — change specific items (e.g., "#2 → IDEA, #4 → IDEA")
3. **Edit items** — modify wording of specific items
4. **Cancel** — discard everything

### Reclassify flow

If the user selects "Reclassify," use `AskUserQuestion` (free-form):
> "Which items should change? (e.g., '#2 → IDEA, #4 → IDEA')"

Parse the response, update classifications, re-present the summary table, and ask for approval again. Loop until approved or cancelled.

### Edit flow

If the user selects "Edit items," use `AskUserQuestion` (free-form):
> "Which items need changes? (e.g., '#2: Fix login redirect loop on mobile only')"

Parse, update, re-present, and ask for approval again.

## Step 4: Allocate IDs

1. Compute the next IDEA ID: glob `.soloflow/active/ideas/IDEA-*.md` and `.soloflow/archive/ideas/IDEA-*.md`, extract each numeric suffix, take `max + 1` (zero-padded to 3 digits). See the "ID allocation" section in the project `CLAUDE.md` for the shared recipe.
2. Compute the next TASK ID: glob `.soloflow/active/plans/**/TASK-*-plan.md`, `.soloflow/active/stuck/**/TASK-*-stuck.md`, `.soloflow/archive/done/**/TASK-*-done.md`, extract each numeric suffix, take `max + 1` (zero-padded to 3 digits).
3. Assign IDs sequentially: IDEAs get consecutive IDEA-NNN IDs, TASKs get consecutive TASK-NNN IDs, in the order they appear in the approved list.

## Step 5: Batch-Create Files

### For each IDEA item

Write to `.soloflow/active/ideas/IDEA-{NNN}.md` with `noclobber`/`wx` semantics. If collision, recompute next ID and retry.

```markdown
---
id: IDEA-{NNN}
type: {FEATURE|REFACTOR|EXPLORATION}
status: draft
created: {ISO timestamp}
source: braindump
slices:
  - title: "{item text, truncated to ~60 chars if needed}"
    description: "{full item text}"
    value_statement: "Captured during braindump — needs refinement"
open_questions: []
assumptions: []
research_recommendation: not_needed
research_rationale: "Braindump capture — run /soloflow:idea-extractor IDEA-{NNN} for full extraction"
---

# {item text}

## Raw Input

{item text, verbatim}

## Grounding

Not yet grounded — run `/soloflow:idea-extractor IDEA-{NNN}` for codebase grounding, or `/soloflow:planner IDEA-{NNN}` to refine directly.

## Slices

### {item text}
{full item text}

## Open Questions

None yet — pending full extraction.

## Assumptions

None yet — pending full extraction.
```

### For each TASK item

Write to `.soloflow/active/plans/TASK-{NNN}-plan.md` with `noclobber`/`wx` semantics. If collision, recompute next ID and retry.

```markdown
---
id: TASK-{NNN}
idea: braindump
status: ready
created: {ISO timestamp}
source: braindump
files_owned: []
files_readonly: []
acceptance_criteria:
  - criterion: "{item text}"
    verification: "manual"
depends_on: []
estimated_complexity: low
---

# {item text}

## Objective

{full item text}

## Implementation Steps

1. Investigate and implement: {item text}

## Acceptance Criteria

- [ ] {item text}
```

### Update backlog

If any TASKs were created, read `.soloflow/active/backlog.json`, add each new task:

```json
{
  "id": "TASK-{NNN}",
  "status": "ready",
  "depends_on": [],
  "created": "{ISO timestamp}"
}
```

Write the updated backlog.json back.

## Step 6: Commit

1. Stage only the specific files created:
   - Each `.soloflow/active/ideas/IDEA-{NNN}.md`
   - Each `.soloflow/active/plans/TASK-{NNN}-plan.md`
   - `.soloflow/active/backlog.json` (if any TASKs were created)
2. Never `git add .` / `git add -A`.
3. If `git diff --cached --quiet` reports no staged changes, skip.
4. Otherwise commit: `chore: braindump — {idea_count} ideas, {task_count} tasks`
5. Skip this step silently if the project is not inside a git repo or if `.soloflow/` is gitignored.

## Step 7: Report and route to planner

Print a summary:

```
## Braindump Complete

Created:
  Ideas: IDEA-{first}..IDEA-{last} ({count})
  Tasks: TASK-{first}..TASK-{last} ({count}) — added to backlog

Next steps:
  /soloflow:idea-extractor IDEA-{NNN}   — full extraction with codebase grounding
  /soloflow:sprint                     — execute ready tasks from backlog
```

If no IDEAs were created (TASKs only), stop here.

Otherwise, use the **AskUserQuestion** tool to ask whether to refine the new IDEAs now. Do not phrase this as a suggestion in prose — the user must answer through the picker.

- `question`: `"Refine the new IDEA(s) into execution-ready tasks now?"`
- `header`: `"Refine now"`
- `multiSelect`: `false`
- `options` (in this order):
  1. `label: "Refine all (Recommended)"`, `description: "Run /soloflow:planner inline for each new IDEA, sequentially, in this same session."`
  2. `label: "Refine some"`, `description: "Pick which IDEA IDs to refine now; the rest stay in active/ideas/ for later."`
  3. `label: "Not yet"`, `description: "Stop here. Run /soloflow:planner IDEA-{NNN} later when ready."`

The tool call blocks until the user responds.

**Branch on the answer:**

- **Not yet** → print the deferred-commands hint and stop:
  ```
  Run these commands when you're ready to refine:
    /soloflow:planner IDEA-{first}
    /soloflow:planner IDEA-{...}
  ```
- **Refine all** → set `to_refine = [every newly created IDEA-{NNN}]`.
- **Refine some** → use a follow-up `AskUserQuestion` (free-form) asking *"Which IDEA IDs? (e.g., 'IDEA-007, IDEA-009')"*. Parse the response into a list of IDs intersected with the IDs created in this run; that becomes `to_refine`. If `to_refine` ends up empty, print the deferred-commands hint and stop.

**Resolve parallelism config** once before refining:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" \
    --key parallelism.task_refiner_parallel --key models.task_decomposer \
    --key models.task_refiner --key limits.context_limit_respawn_max \
    --fallback true --fallback sonnet --fallback opus --fallback 3
```

Lines: parallelism toggle / task-decomposer model / task-refiner model / respawn cap.

**Branch on `to_refine.length` and the parallelism toggle:**

- **`to_refine.length === 1`** OR **parallelism toggle === false** → fall back to sequential per-IDEA invocation. For each ID in `to_refine`, in order: read `${CLAUDE_PLUGIN_ROOT}/commands/planner.md` with the `Read` tool and execute its procedure end-to-end with `$ARGUMENTS` set to that ID. Treat each invocation as a continuation of this run — including the planner's own human checkpoint. Do not re-run the planner's Step 1 idea-picker; the ID is already known. Stop after the last ID's planner run completes.

- **`to_refine.length >= 2` AND parallelism toggle === true** → run the parallel orchestration below. This replaces the inline planner.md loop with cross-IDEA fan-out plus a single combined human checkpoint at the end.

### Parallel multi-IDEA refinement

1. **Per-IDEA setup (sequential, fast).** For each ID in `to_refine`:
   - Read `.soloflow/active/ideas/{ID}.md` content.
   - Note that no research report exists for braindump-source IDEAs (they're freshly captured here without research). Pass empty research to the decomposer.
   Discover existing epics ONCE for the whole batch: glob `.soloflow/active/plans/*/EPIC-*.md` and collect each slug + body. Same list passed to every decomposer.

2. **Decomposer fan-out.** Issue **one message containing one `Agent` tool call per selected IDEA** (`subagent_type: "task-decomposer"`, `model: <resolved task_decomposer>`). Each call's prompt is the standard decomposer payload from `commands/planner.md` Step 2 parallel path step 1, scoped to its IDEA. Wait for all calls to return.

3. **Parse and validate each skeleton.** Apply the same JSON parse + validation pre-checks as `commands/planner.md` Step 2 parallel path steps 2–3 (slot uniqueness, depends_on locality, files_owned_hint disjointness within the IDEA, epic-slug consistency). On any IDEA's decomposer failing parse twice or producing invalid skeleton: drop that IDEA from the batch, surface it in the combined checkpoint as `Decomposition failed for IDEA-{NNN}`, and continue with the rest.

4. **Allocate real TASK-NNN IDs across all IDEAs.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/next-ids.js" --kind task` ONCE for the batch starting counter. Walk the IDEAs in `to_refine` order; for each IDEA, walk its skeleton's `tasks[]` in source order and assign sequential TASK-NNN IDs from the running counter. Build a per-IDEA slot→TASK map. Remap each task's `depends_on` from slot IDs to real TASK IDs using its IDEA's map. Cross-IDEA dependencies are not allowed (decomposer's contract is per-IDEA).

5. **Detailer fan-out.** Build the prompt for each task across all IDEAs, in the same shape as `commands/planner.md` Step 2 parallel path step 6 (`MODE: detail`, `TASK_ID:`, `TASK_SKELETON:` with remapped depends_on, `SIBLING_DAG:` covering only that IDEA's siblings, IDEA body, no research, existing-epics list). Issue **one message containing one `Agent` tool call per task across the entire batch** (`subagent_type: "task-refiner"`, `model: <resolved task_refiner>`). Wait for all calls to return.

6. **Collate per-IDEA, parity gates, materialize EPIC files.** For each IDEA in the batch:
   - Collect its detailer outputs.
   - On `CONTEXT_LIMIT` from any detailer, respawn that one slot only with handoff (cap at resolved `limits.context_limit_respawn_max`); on terminal failure drop the slot and surface in the combined checkpoint.
   - Apply parity gates 3a (`test_strategy` ↔ `files_owned`) and 3b (`acceptance_criteria` ↔ `files_owned`/`files_readonly`) per `commands/planner.md`. Record auto-corrections per-plan and per-IDEA.
   - Generate `EPIC-{slug}.md` bodies for entries in this IDEA's decomposer `new_epics[]`.

7. **Write all plans + EPIC files.** For each IDEA, write its plans to `.soloflow/active/plans/{epic}/TASK-{NNN}-plan.md` (or flat for orphans) using `wx`/noclobber semantics. On collision, recompute the next ID for the remaining unwritten plans and retry. Add each task to `.soloflow/active/backlog.json` with `status: "ready"` + remapped `depends_on`. Write each new EPIC body if not already present.

8. **Single combined human checkpoint.** Print a per-IDEA summary block first (count, dep graph, epic groupings, parity-gate auto-corrections, dropped slots, scope_drops) then use **AskUserQuestion** (single question, single-select):
   - `question`: `"How should we proceed with the {N} refined IDEAs?"`
   - `options`:
     1. `label: "Approve all (Recommended)"` — leave every task `status: "ready"`.
     2. `label: "Approve subset"` — follow up with a free-form `AskUserQuestion` asking which IDEA IDs (or specific TASK IDs) to defer; mark those as `status: "deferred"` in `backlog.json`.
     3. `label: "Reject all"` — delete every plan file written in this batch and remove their backlog entries.
     4. `label: "Cancel"` — leave plan files on disk and backlog entries `ready` but stop here without committing or archiving.

   The tool call blocks until the user responds.

9. **Commit state.** Stage only the specific paths touched (each plan file written, every modified EPIC-{slug}.md, `.soloflow/active/backlog.json`). Never `git add .`. If `git diff --cached --quiet` reports no staged changes, skip. Otherwise:
   - **Approve all** → commit `chore: queue TASK-{first}..TASK-{last} from braindump batch` (cite the IDEA range too if useful).
   - **Approve subset** → same commit message, plus a "deferred: TASK-X, TASK-Y" line in the body.
   - **Reject all** → `git rm` the deleted plans + revert the backlog entries; commit `chore: reject braindump-batch plans`.
   - **Cancel** → no commit. Stop.

10. **Archive source IDEAs.** For every IDEA in the batch whose plans were not "Reject all"-deleted:
    - `mkdir -p .soloflow/archive/ideas`
    - Move `.soloflow/active/ideas/{ID}.md` → `.soloflow/archive/ideas/{ID}.md`. (No research files for braindump-source IDEAs.)
    - `git add` the moved files; commit `chore: archive {first-id}..{last-id} from braindump batch` (single combined commit).

    Skip silently if not in a git repo or `.soloflow/` is gitignored.

11. **Final report.** Print:
    ```
    Refined {N} IDEAs in parallel.
    - Tasks created: {count} (TASK-{first}..TASK-{last})
    - Approved: {ready_count} | Deferred: {deferred_count} | Rejected: {rejected_count}

    Next step: /soloflow:sprint
    ```
