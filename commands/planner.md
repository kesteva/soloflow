---
description: Plan a new idea, braindump multiple items, or refine an existing idea into execution-ready tasks
argument-hint: "[IDEA-NNN | --mode=single-idea <text> | --mode=multi-idea <items> | <text>]"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:planner

Unified entry for the SoloFlow planning phase. Two internal phases:

- **Phase 1 — Extract (optional)** produces IDEA file(s) from raw input. Two sub-modes: single-idea (clarify + idea-extractor agent + research) or multi-idea (heuristic braindump classification).
- **Phase 2 — Refine** turns IDEA file(s) into execution-ready plans via the task-decomposer + parallel detailers.

`/soloflow:idea-extractor` and `/soloflow:braindump` are preconfigured wrappers that dispatch into this command with `--mode=single-idea` or `--mode=multi-idea` prepended.

The user's input is: **$ARGUMENTS**

---

## Model + limits resolution

Resolve the relevant config values once. Run via Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" \
    --key models.task_refiner --key models.task_decomposer \
    --key models.idea_extractor --key models.researcher \
    --key limits.context_limit_respawn_max \
    --key parallelism.task_refiner_parallel \
    --key phases.clarify --key phases.research \
    --key parallelism.phase_worktrees \
    --fallback opus --fallback sonnet --fallback sonnet --fallback sonnet \
    --fallback 3 --fallback true --fallback true --fallback true \
    --fallback false
```

Lines: 1=task_refiner model · 2=task_decomposer model · 3=idea_extractor model · 4=researcher model · 5=respawn cap · 6=task-refiner parallelism toggle · 7=clarify-phase toggle · 8=research-phase toggle · 9=phase-worktrees toggle.

## Step 0: Initialize

If `.soloflow/` does not exist, report `"SoloFlow not initialized. Run /soloflow:init first."` and stop.

## Step 0.5: Mode resolution

Inspect `$ARGUMENTS` and route into one of three modes (`single-idea`, `multi-idea`, `refine`). Carry `mode` forward into the appropriate phase.

1. **`refine` (existing IDEA)** — If `$ARGUMENTS` matches `^IDEA-\d{3,}$` (case-insensitive), set `mode = refine`, `target_id = <argument>`. Skip Phase 1, jump straight to Phase 2.

2. **`single-idea`** — Else if `$ARGUMENTS` matches `^--mode=single-idea(\s+|$)` (with optional whitespace + remaining text), set `mode = single-idea`, `raw = <$ARGUMENTS with the leading token and following whitespace stripped>`. If `raw` is empty, fall back to a follow-up `AskUserQuestion` (free-form: `"Describe the idea"`) and set `raw` to the response. Run Phase 1a. After Phase 1a completes, fall through to Phase 2 unless the user opted to defer refinement.

3. **`multi-idea`** — Else if `$ARGUMENTS` matches `^--mode=multi-idea(\s+|$)`, set `mode = multi-idea`, `raw = <stripped>`. If `raw` is empty, run Phase 1b in **interactive mode** (the loop in Phase 1b Step 1.B). Run Phase 1b. After Phase 1b completes, fall through to Phase 2 if the user opted to refine; otherwise stop.

4. **Open prompt** — Otherwise (no `IDEA-NNN`, no recognized `--mode=` token), use `AskUserQuestion`:
   - **Question:** `"What do you want to do?"`
   - **Header:** `"Planning mode"`
   - **Options:**
     1. `"Plan a new idea"` — `(Recommended)` — single-idea extraction.
     2. `"Braindump multiple items"` — multi-idea heuristic capture.
     3. `"Refine an existing idea"` — pick a draft IDEA from `active/ideas/`.
   The tool blocks until the user responds.

   After the user picks, branch on the answer:
   - **Plan a new idea** → If `$ARGUMENTS` is non-empty, set `raw = $ARGUMENTS`; else use a follow-up free-form `AskUserQuestion` (`"Describe the idea"`) and set `raw` to the response. Set `mode = single-idea`. Continue to Phase 1a.
   - **Braindump multiple items** → If `$ARGUMENTS` is non-empty, set `raw = $ARGUMENTS`; else run Phase 1b in interactive mode. Set `mode = multi-idea`. Continue to Phase 1b.
   - **Refine an existing idea** → Glob `.soloflow/active/ideas/IDEA-*.md` and surface each ID as one option in a follow-up single-select `AskUserQuestion` (`"Which idea?"`, header `"Idea"`). Set `mode = refine`, `target_id = <picked>`. Skip Phase 1; jump to Phase 2.

If the user types `/soloflow:planner --mode=foo` with an unknown mode token, ignore it and fall through to the open prompt above.

---

## Step 0.6: Phase worktree setup

Read the resolved `parallelism.phase_worktrees` value (line 9 of the config block above). Default `false`.

Capture `MAIN_CWD` = the project root the orchestrator started in. Phase 3 (merge) runs from `MAIN_CWD`.

**If `phase_worktrees` is `false`** (legacy direct-write flow): set `WORKTREE_ROOT = MAIN_CWD`, `PHASE_ID = null`, `PHASE_BRANCH = null`. Skip the worktree creation. The directive paragraph below still applies — `SOLOFLOW_ROOT` just resolves to the project root and behavior is unchanged.

**If `phase_worktrees` is `true`:**

1. Compute `PHASE_ID`: a UTC timestamp `YYYYMMDDTHHMMSS` (filename-safe, sortable, unique-per-second across concurrent invocations).

2. Create the phase worktree via Bash from `MAIN_CWD`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/state/phase-worktree-setup.js" --phase planning --id "$PHASE_ID"
   ```

   Parse the JSON output. Capture `worktree` (absolute) as `WORKTREE_ROOT` and `branch` as `PHASE_BRANCH`. Capture `base_branch` as `BASE_BRANCH`.

3. **On setup failure** (non-zero exit, `git worktree add` error, or branch-already-exists): print the stderr, then print:

   ```
   Phase worktree setup failed. Falling back to direct-write flow on the main checkout.
   ```

   Set `WORKTREE_ROOT = MAIN_CWD`, `PHASE_ID = null`, `PHASE_BRANCH = null`. Continue.

### Working directory directive (applies to all subsequent steps until Phase 3)

Two simple rules cover every operation. **You do not need to remember a third.**

1. **Set the env var once.** At the top of every Bash command from this point forward, prefix with `SOLOFLOW_ROOT="$WORKTREE_ROOT" ` (or, if you control the shell session, `export SOLOFLOW_ROOT="$WORKTREE_ROOT"` once and let subsequent commands inherit). Every helper script under `scripts/state/` and `scripts/refiner/` reads `SOLOFLOW_ROOT` and auto-targets the worktree's `.soloflow/`. The orchestrator does not have to thread `--cwd`/path args manually.

   For raw `git` operations (commit, add, mv, rm) and direct shell ops (mkdir, mv files), use `git -C "$WORKTREE_ROOT" ...` and `cd "$WORKTREE_ROOT" && ...` respectively. These are the operations that don't go through SoloFlow helpers.

2. **For Read / Write / Edit tool calls touching `.soloflow/`, prepend `$WORKTREE_ROOT/`.** E.g. `WORKTREE_ROOT/.soloflow/active/ideas/IDEA-018.md`, never the project-relative `.soloflow/active/ideas/IDEA-018.md`. (Read tools cannot inherit env vars; only absolute paths work.)

For subagent spawns, prepend the directive `WORKTREE_ROOT: <abs path = $WORKTREE_ROOT>` as the first line of the prompt body. The planning agents (`task-decomposer`, `task-refiner`, `idea-extractor`) have a "Working directory" section that structurally honors this — they don't need per-spawn instructions about WHICH paths to absolutize.

When `phase_worktrees=false` and `WORKTREE_ROOT == MAIN_CWD`, the `SOLOFLOW_ROOT` export and the path prefix are both no-ops; the directive imposes no behavior change.

---

# Phase 1a — Single-idea extract

Runs only when `mode = single-idea`. Produces one IDEA file (and optionally a research report). After Phase 1a, the planner offers Phase 2 ("Refine now?"); on opt-in it falls through, on opt-out it stops with a deferred-commands hint.

## Step 1a.1: Clarify if ambiguous

Resolve `clarify_enabled`:
- If `raw` contains the literal token `--skip-clarify`, set `clarify_enabled = false` and strip the token from `raw` before using it downstream.
- Else use the resolved `phases.clarify` value (line 7 of the config block above). Default `true`.

If `clarify_enabled` is false, set `brief = raw` and proceed to Step 1a.2.

Otherwise:
1. Read `${CLAUDE_PLUGIN_ROOT}/skills/clarify-idea/SKILL.md` via the `Read` tool and apply its **"When to invoke"** checklist against `raw`. The checklist covers: goal, target user/surface, success signal, scope boundary, grounding.
2. If every checklist item is satisfied, the input is already clear — set `brief = raw` and proceed to Step 1a.2 without running the loop.
3. Otherwise, run the clarification routine defined in the skill:
   - Honor the scope-decomposition gate first (if the ask spans multiple independent subsystems, pick one via `AskUserQuestion`).
   - Run the clarification loop: one `AskUserQuestion` at a time, preferring multi-choice, following threads, until the checklist is satisfied.
   - Present the skill's hard-gated readiness prompt (`"Ready to extract the idea?"` — Extract now / Keep clarifying / Cancel). Loop on `Keep clarifying`. Stop the whole command on `Cancel`.
   - On `Extract now`, assemble the **clarified brief** (raw input + transcript + synthesis paragraph) exactly as the skill specifies and set `brief` to that markdown block.

## Step 1a.2: Extract the Idea

1. Generate the next idea ID by globbing `.soloflow/active/ideas/IDEA-*.md`, extracting each numeric suffix, and taking `max + 1` (zero-padded to 3 digits).
2. Spawn the **idea-extractor** agent via the Agent tool (`subagent_type: "idea-extractor"`, `model: <resolved idea_extractor>`) with:
   - `brief` — the raw text or the clarified brief from Step 1a.1. If clarified, prefix with: *"The following is a clarified brief produced from a user conversation. Treat the Synthesis section as the canonical ask; use the transcript only for extra context."*
   - The idea ID to use.
   - Instruction: `"Extract and structure this idea. Use the provided idea ID. Output the complete IDEA file content."`
3. Capture the extractor's output.
4. Write the idea file to `.soloflow/active/ideas/IDEA-{NNN}.md` using `wx`/noclobber semantics. If the target already exists (another parallel worker raced), recompute the next ID and retry.

**BUGFIX routing:** If the extractor classified the idea as BUGFIX, tell the user: `"This looks like a bug. Consider /soloflow:quick for faster resolution."` Then stop — do not proceed to research or Phase 2.

## Step 1a.3: Human Checkpoint — Idea Review

Print a prose summary of the idea first so the user has context:
- Type and classification
- Slices (with value statements)
- Assumptions that need validation

Do NOT print the open questions as prose — they go into the structured picker below.

Then make a **single batched `AskUserQuestion` call** whose questions list is built in this order:

1. **One question per `open_questions` entry** from the extractor output, in order. For each:
   - `question`: the `question` field verbatim
   - `header`: a short label derived from the question (≤20 chars)
   - `options`: the extractor's `candidates` array if present (2–4 concrete candidate answers). If `candidates` is absent or empty, pass an empty options list and the user will answer free-form. The `AskUserQuestion` built-in free-form fallback is always available.

2. **Final question — the proceed picker.** Read the extractor's `research_recommendation` and `research_rationale`. Print a one-line recommendation before the question:
   - If `recommended`: *"Research recommended — {research_rationale}"*
   - If `not_needed`: *"Research likely not needed — {research_rationale}"*

   Use `research_enabled` from the resolved `phases.research` (line 8 of the config block). If false, omit the `Approve + Research` option entirely.

   Question: `"How should we proceed with IDEA-{NNN}?"` with options:
   - **Approve + Research** — run external research next. Label `(recommended)` if `research_recommendation` is `recommended`. *(Omitted when `phases.research === false`.)*
   - **Approve (skip research)** — stop here; idea is ready for refinement. Label `(recommended)` if `research_recommendation` is `not_needed` or research is disabled.
   - **Modify** — update slices, answer questions, add constraints.
   - **Reject** — delete the idea file and stop.

If the extractor produced zero open questions, the batch degenerates to just the proceed picker — that's fine.

The tool call blocks until the user responds to every question.

**After the tool returns, update the idea file:**
- For each answered open question, append `**Answer:** {user response}` beneath the question under `## Open Questions` in the body, and mirror the answer into the YAML frontmatter as `open_questions[i].answer`.
- If every open question got an answer, flip `status: draft` → `status: answered`. Otherwise leave status unchanged.

**Then branch on the proceed answer:**
- **Approve + Research** → continue to Step 1a.4.
- **Approve (skip research)** → skip Step 1a.4, go to Step 1a.5.
- **Modify** → use `AskUserQuestion` follow-ups to collect modifications, update the idea file, then re-present this Step's batched picker. Loop until the user approves or rejects.
- **Reject** → delete the idea file and stop the whole command.

## Step 1a.4: Research (if selected)

If the user chose `Approve + Research`:

1. Spawn the **shadow-researcher** agent (`subagent_type: "shadow-researcher"`, `model: <resolved researcher>`) with:
   - The approved idea file content.
   - Instruction: `"Research this idea. For each slice, search for existing libraries, best practices, API docs, and prior art. For each open question, attempt to find an external answer. For each low/medium-confidence assumption, search for evidence. Output a structured research report."`
2. Capture the researcher's output.
3. Write the research report to `.soloflow/active/research/IDEA-{NNN}-research.md`.

## Step 1a.5: Commit state

Commit the newly written state files via Bash. Stage only the specific paths you wrote.

1. `git add .soloflow/active/ideas/IDEA-{NNN}.md` (and `.soloflow/active/research/IDEA-{NNN}-research.md` if Step 1a.4 ran).
2. If `git diff --cached --quiet` reports no staged changes, skip (idempotent re-run).
3. Otherwise `git commit -m "chore: capture IDEA-{NNN}"`.

Skip silently if the project is not inside a git repo (`git rev-parse --is-inside-work-tree`) or if `.soloflow/` is gitignored.

## Step 1a.6: Decide whether to refine now

Print a one-line summary:
```
Idea extracted: IDEA-{NNN} ({title})
{Research report: IDEA-{NNN}-research.md  — if applicable}
```

Use **AskUserQuestion** (single-select):
- `question`: `"Refine IDEA-{NNN} into execution-ready tasks now?"`
- `header`: `"Refine now"`
- `options`:
  1. `"Refine now (Recommended)"` — fall through to Phase 2 in this same session.
  2. `"Not yet"` — stop here. Run `/soloflow:planner IDEA-{NNN}` later.

The tool blocks until the user responds.

- On **Not yet** (or any free-form deferral): print `"Run /soloflow:planner IDEA-{NNN} when you're ready to refine."`, then run **Phase 3** with `cancel = false` and stop.
- On **Refine now**: set `to_refine = [IDEA-{NNN}]`, `target_id = IDEA-{NNN}`. Continue to Phase 2.

---

# Phase 1b — Multi-idea heuristic capture

Runs only when `mode = multi-idea`. Mirrors today's `/soloflow:braindump` flow: parse a bullet list, classify each item via heuristics (no agent), present a batch summary, batch-create IDEA + TASK files, and prompt to refine the new IDEAs.

## Step 1b.1: Capture

Branch on whether `raw` is non-empty.

### A. Inline (`raw` provided)

1. Parse `raw` as a list. Accept any of:
   - Markdown bullets (`- item`)
   - Numbered lists (`1. item`)
   - Newline-separated plain lines
2. Each line/bullet becomes one **raw item**. Strip leading bullets, numbers, and whitespace.
3. Proceed to Step 1b.2.

### B. Interactive (`raw` empty)

1. Use `AskUserQuestion` with a free-form prompt: `"What's on your mind? Type an idea, bug, or task. (Type **done** when finished.)"`
2. Collect the response as item 1. If the user typed `done` (case-insensitive, ignoring punctuation) as their first response, report `"No items captured."` and stop.
3. Loop with `"Next idea? ({N} captured so far. Type **done** to finish.)"`.
4. When the user types `done`, stop collecting.
5. Proceed to Step 1b.2.

## Step 1b.2: Classify

For each raw item, apply heuristic classification. No agent is spawned.

### TASK (bounded, actionable change)

Classify as **TASK** if ANY of:
- Starts with an action verb: fix, bug, patch, update, change, rename, remove, delete, move, add (when followed by a specific noun, not a broad feature).
- Contains bug-related language: `"is broken"`, `"doesn't work"`, `"typo"`, `"wrong"`, `"missing"`, `"crash"`, `"error"`.
- Is a clearly bounded single change — roughly fewer than 15 words describing one concrete action.

TASK type sub-classification:
- `BUGFIX` if bug-related language is present.
- Otherwise omit type (tasks don't carry a type field).

### IDEA (needs extraction/refinement)

Classify as **IDEA** if ANY of:
- Contains feature language: `"should"`, `"could"`, `"what if"`, `"explore"`, `"consider"`, `"redesign"`, `"rethink"`, `"add support for"`, `"implement"`, `"build"`, `"create"`.
- Describes a multi-step initiative or system-level change.
- Is ambiguous or open-ended.

**Default fallback:** If uncertain, classify as **IDEA**.

IDEA type sub-classification:
- `REFACTOR` if `"refactor"`, `"restructure"`, `"clean up"`, `"reorganize"` appear.
- `EXPLORATION` if `"explore"`, `"investigate"`, `"research"`, `"spike"` appear.
- `FEATURE` otherwise.

## Step 1b.3: Present summary + approve

Display the classified list as a formatted table:

```
## Braindump Summary — {N} items captured

| #  | Item                          | → | Type    |
|----|-------------------------------|---|---------|
| 1  | Add dark mode support         | IDEA  | FEATURE |
| 2  | Fix login redirect loop       | TASK  | BUGFIX  |
| 3  | Refactor auth middleware       | IDEA  | REFACTOR|
| 4  | Rename config key foo→bar     | TASK  | —       |
```

Then use **AskUserQuestion** with options:

1. **Approve all** — create all files as classified.
2. **Reclassify** — change specific items.
3. **Edit items** — modify wording.
4. **Cancel** — discard everything.

### Reclassify flow

If `Reclassify`, use a free-form `AskUserQuestion`: `"Which items should change? (e.g., '#2 → IDEA, #4 → IDEA')"`. Parse the response, update classifications, re-present the table. Loop.

### Edit flow

If `Edit items`, use a free-form `AskUserQuestion`: `"Which items need changes? (e.g., '#2: Fix login redirect loop on mobile only')"`. Parse, update, re-present. Loop.

If `Cancel`, stop the whole command.

## Step 1b.4: Allocate IDs

1. Compute the next IDEA ID: glob `.soloflow/active/ideas/IDEA-*.md` and `.soloflow/archive/ideas/IDEA-*.md`, extract numeric suffixes, take `max + 1` (zero-padded to 3).
2. Compute the next TASK ID: glob `.soloflow/active/plans/**/TASK-*-plan.md`, `.soloflow/active/stuck/**/TASK-*-stuck.md`, `.soloflow/archive/done/**/TASK-*-done.md`, take `max + 1`.
3. Assign IDs sequentially in the approved-list order.

## Step 1b.5: Batch-create files

### For each IDEA item

Write to `.soloflow/active/ideas/IDEA-{NNN}.md` with `wx`/noclobber semantics. On collision, recompute next ID.

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
research_rationale: "Braindump capture — research can be requested before refinement"
---

# {item text}

## Raw Input

{item text, verbatim}

## Grounding

Not yet grounded — run `/soloflow:planner IDEA-{NNN}` to refine and ground.

## Slices

### {item text}
{full item text}

## Open Questions

None yet — pending full extraction.

## Assumptions

None yet — pending full extraction.
```

### For each TASK item

Write to `.soloflow/active/plans/TASK-{NNN}-plan.md` with `wx`/noclobber semantics.

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

Each TASK plan written above already carries `status: ready` in its frontmatter, so it's immediately discoverable by `plan-query.js --status ready`. No separate queue file to update.

## Step 1b.6: Commit

1. Stage only the specific files created (each `IDEA-{NNN}.md` and `TASK-{NNN}-plan.md`).
2. Never `git add .` / `git add -A`.
3. If `git diff --cached --quiet` reports no staged changes, skip.
4. Otherwise commit: `chore: braindump — {idea_count} ideas, {task_count} tasks`.
5. Skip silently if not in a git repo or `.soloflow/` is gitignored.

## Step 1b.7: Report and prompt to refine

Print a summary:

```
## Braindump Complete

Created:
  Ideas: IDEA-{first}..IDEA-{last} ({count})
  Tasks: TASK-{first}..TASK-{last} ({count}) — status: ready in plan frontmatter

Next steps:
  /soloflow:planner IDEA-{NNN}   — refine an idea into tasks
  /soloflow:sprint               — execute ready tasks from the queue
```

If no IDEAs were created (TASKs only), stop here.

Otherwise use **AskUserQuestion**:
- `question`: `"Refine the new IDEA(s) into execution-ready tasks now?"`
- `header`: `"Refine now"`
- `multiSelect`: `false`
- `options`:
  1. `"Refine all (Recommended)"` — refine every new IDEA inline.
  2. `"Refine some"` — pick a subset.
  3. `"Not yet"` — stop here.

The tool blocks until the user responds.

**Branch:**

- **Not yet** → print:
  ```
  Run these commands when you're ready to refine:
    /soloflow:planner IDEA-{first}
    /soloflow:planner IDEA-{...}
  ```
  Then run **Phase 3** with `cancel = false` and stop.
- **Refine all** → set `to_refine = [every newly created IDEA-{NNN}]`. Continue to Phase 2.
- **Refine some** → use a follow-up free-form `AskUserQuestion` (`"Which IDEA IDs? (e.g., 'IDEA-007, IDEA-009')"`). Parse the response into a list of IDs intersected with the IDs created in this run; that becomes `to_refine`. If empty, print the deferred-commands hint, then run **Phase 3** with `cancel = false`, then stop. Otherwise continue to Step 1b.8.

## Step 1b.8: Offer research before refinement (optional)

Mirrors Phase 1a Step 1a.3's research opt-in for the braindump batch: now that `to_refine` is known, ask whether to run the `shadow-researcher` agent on those IDEAs before Phase 2 picks them up. Phase 2's per-IDEA setup already auto-detects `.soloflow/active/research/{ID}-research.md` and threads it into the decomposer (single-IDEA Step 2.1 step 3 / multi-IDEA step 1), so writing the report is sufficient — no other wiring is required.

**Skip this entire step** (fall straight through to Phase 2) if either:
- `to_refine` is empty (the user picked `Not yet`, or `Refine some` with an empty selection — those branches already routed to Phase 3 / stop above).
- The resolved `phases.research` value (line 8 of the config block at the top of this command) is `false`. Matches Step 1a.3's behavior of omitting `Approve + Research` when research is globally disabled.

Otherwise:

1. Use **AskUserQuestion** (single-select):
   - `question`: `"Research the {N} IDEA(s) about to be refined? Research runs the shadow-researcher agent per IDEA and writes a report Phase 2 will consume."`
   - `header`: `"Research"`
   - `options`:
     1. `"Skip research (Recommended)"` — proceed straight to Phase 2 with no research files. Braindump items are typically too thin to benefit from external research; this matches the historical default.
     2. `"Research all"` — run shadow-researcher on every IDEA in `to_refine`.
     3. `"Research some"` — pick a subset.

   The tool blocks until the user responds.

2. Resolve `to_research`:
   - **Skip research** → `to_research = []`.
   - **Research all** → `to_research = to_refine`.
   - **Research some** → follow-up free-form `AskUserQuestion` (`"Which IDEA IDs? (e.g., 'IDEA-007, IDEA-009')"`). Parse the response into a list of IDs intersected with `to_refine`. Empty → `to_research = []`. Otherwise → `to_research = <parsed set>`.

3. If `to_research` is empty, print `"Research skipped."` and continue to Phase 2.

4. Otherwise, **run research in parallel.** Issue **one message containing one `Agent` tool call per IDEA** in `to_research` (mirrors the parallel fan-out pattern used by Phase 2). Each call:
   - `subagent_type: "shadow-researcher"`
   - `model: <resolved researcher>` (line 4 of the config block)
   - Prompt body, identical to the Step 1a.4 contract:
     - The full IDEA file content for that ID (read from `.soloflow/active/ideas/{ID}.md`, prefixed with `WORKTREE_ROOT/` per the working-directory directive in Step 0.6).
     - Instruction: `"Research this idea. For each slice, search for existing libraries, best practices, API docs, and prior art. For each open question, attempt to find an external answer. For each low/medium-confidence assumption, search for evidence. Output a structured research report."`

   Wait for all calls to return.

5. **Write reports.** For each agent output, write to `.soloflow/active/research/{IDEA_ID}-research.md` (creating the `research/` directory if missing). Use the worktree-prefixed path.

6. **Commit reports.** Stage only the research file paths written. If `git diff --cached --quiet` reports no staged changes, skip. Otherwise commit `chore: research {first-id}..{last-id} from braindump` (single id form when only one IDEA was researched). Skip silently if not in a git repo or `.soloflow/` is gitignored.

7. Print `"Research complete: IDEA-{NNN}{, IDEA-{MMM}...}"` and continue to Phase 2.

---

# Phase 2 — Refine

Runs when:
- `mode = refine` (single IDEA from CLI / open-prompt picker), OR
- After Phase 1a (single IDEA freshly extracted), OR
- After Phase 1b (one or more IDEAs freshly braindumped).

Determine `to_refine`:
- If arriving from `mode = refine` or Phase 1a → `to_refine = [target_id]`.
- If arriving from Phase 1b → `to_refine` was set in Step 1b.7.

Branch on `to_refine.length` and the resolved `parallelism.task_refiner_parallel` toggle:

- **`to_refine.length === 1`** → run **Phase 2 — single-IDEA path** below.
- **`to_refine.length >= 2` AND `parallelism.task_refiner_parallel === true`** → run **Phase 2 — multi-IDEA parallel path** below.
- **`to_refine.length >= 2` AND `parallelism.task_refiner_parallel === false`** → fall back to sequential per-IDEA invocation: for each ID in `to_refine`, in order, run the single-IDEA path with `target_id = <ID>`. Stop after the last one.

## Phase 2 — single-IDEA path

### Step 2.1: Load the Idea

1. `target_id` is already known (from Step 0.5 / Phase 1a / one-at-a-time loop). If somehow not, list `.soloflow/active/ideas/` via `AskUserQuestion` and let the user pick.
2. Read `.soloflow/active/ideas/{target_id}.md`. If missing, report the error and stop.
3. Check for `.soloflow/active/research/{target_id}-research.md` — if present, it will be passed to the refiner.
4. Compute the starting task counter via `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/next-ids.js" --kind task` — globs every TASK file location and returns the next zero-padded ID.
5. Discover existing epics: glob `.soloflow/active/plans/*/EPIC-*.md` and collect each epic slug (parent folder name) and `EPIC-{slug}.md` contents. Pass these to the refiner so it can reuse epics instead of duplicating them.

### Step 2.2: Refine

Two paths: **parallel** (decomposer + N detailers) when `parallelism.task_refiner_parallel === true`, **legacy** (single whole-IDEA refiner call) when `false`. Pick once based on the resolved value.

#### Step 2.2 — legacy path (parallelism disabled)

Skip this whole subsection if `parallelism.task_refiner_parallel === true`. When disabled:

1. Spawn the **task-refiner** agent (`subagent_type: "task-refiner"`, `model: <resolved task_refiner>`) with:
   - The approved idea file content.
   - If a research report exists, include it with: `"A research report is provided below. Use it to inform your approach selection, library choices, and to resolve open questions before doing your own research."`
   - The starting task counter.
   - The list of existing epics (slug + `EPIC-{slug}.md` contents). Instruct: `"Reuse these existing epics when a task fits their objective. Propose new epic slugs only when 2+ tasks share a coherent objective. Leave epic null for orphan tasks."`
   - Instruction: `"Refine this idea into execution-ready plans. Start task numbering at TASK-{NNN}. Output each plan file's content clearly separated. For any new epic slugs you introduce, also output an EPIC-{slug}.md block."`
2. Capture the refiner's output.
   - On **CONTEXT_LIMIT**: read the `### Handoff` section to get plans produced so far. Write the completed plans to disk. Spawn a fresh task-refiner with the original idea, `"Continue refinement from previous refiner's handoff. These tasks are already planned: {list}. Start numbering at TASK-{next}."`, the handoff content, and the updated counter. Merge outputs. Cap at resolved `limits.context_limit_respawn_max` respawns; after that, proceed with whatever plans exist.
3. Parse the output into individual plan files and any new EPIC-{slug}.md blocks. Before parsing each plan block, pipe its raw text through the post-fence sanitizer:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/refiner/sanitize-plan.js" --task-id TASK-{NNN} --input <raw-plan-tmpfile>
   ```
   Use the returned `body` as the plan content. If `stripped_bytes > 0`, record the count and surface it in Step 2.3 as an advisory: `"Sanitized N bytes of post-fence debug output from TASK-{NNN}'s plan."` Non-blocking; proceed regardless. Skip ahead to Step 2.2c (write + parity gate).

#### Step 2.2 — parallel path (default)

1. **Decompose.** Spawn the **task-decomposer** agent (`subagent_type: "task-decomposer"`, `model: <resolved task_decomposer>`) with:
   - The approved idea file content.
   - The research report (if present), prefaced with: `"A research report is provided below. Use it to inform task boundaries, library choices, and how slices group into tasks."`
   - The list of existing epics (slug + `EPIC-{slug}.md` contents). Instruct: `"Reuse these existing epics when a slot fits their objective; propose a new slug only when 2+ slots share an objective. Leave epic: null for orphans."`
   - Instruction: `"Decompose this idea into a coarse task skeleton per your output schema. Use slot IDs T1..TN — the orchestrator will allocate real TASK IDs. Cross-task invariants (depends_on DAG, files_owned_hint disjointness across siblings, epic decisions) are your responsibility."`
2. **Parse the skeleton.** The decomposer's output is a single fenced JSON block with `tasks[]`, `new_epics[]`, `scope_drops[]`. `JSON.parse` it. On parse failure, retry once with the error message; on second failure, fall back to the legacy path for this run and surface a warning in Step 2.3.
3. **Validate the skeleton.** Before allocating IDs:
   - Each `tasks[].slot` is unique and matches `^T\d+$`.
   - Every `depends_on` entry references a sibling slot.
   - `files_owned_hint` lists are pairwise disjoint across siblings. On overlap: respawn the decomposer once with a targeted note (`"slots TX and TY both claim <path> in files_owned_hint — split or merge"`). On second failure, surface as a Step 2.3 warning and proceed.
   - Every `epic` value is `null`, an existing slug, or a slug that appears in `new_epics`. Mismatches → respawn once, then warn.
4. **Allocate real TASK-NNN IDs.** Use the starting counter from Step 2.1 step 4. Assign IDs sequentially in `tasks[]` source order: slot `T1` → `TASK-{starting}`, `T2` → `TASK-{starting+1}`, etc. Build a slot→TASK map. Remap each task's `depends_on` from slot IDs to real TASK IDs.
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
7. **Collate detailer outputs.** Each detailer output is one `TASK-NNN-plan.md` block. Before parsing, pipe raw text through `scripts/refiner/sanitize-plan.js --task-id TASK-{NNN} --input <tmp>` to strip telemetry tokens. Use the returned `body`. Aggregate `stripped_bytes` per task; surface totals in Step 2.3 as advisory.
   - On **CONTEXT_LIMIT** from any detailer: read its `### Handoff`, then respawn a fresh detailer **for that one slot only** (same prompt shape, plus the previous handoff prepended). Cap at resolved `limits.context_limit_respawn_max` per slot.
   - If a detailer fails entirely (no parseable plan after respawn cap): drop that slot, surface in Step 2.3 as `Detailer failed for TASK-{NNN}: <slug>`, proceed.
8. **Materialize new EPIC files.** For each entry in the decomposer's `new_epics[]`, generate its `EPIC-{slug}.md` body using the schema from `agents/task-refiner.md` Output Format (`originating_ideas: [{target_id}]`, status `active`, the decomposer's title/objective/scope/success_signal). Detailers do NOT emit EPIC blocks in this path.

After step 7 (or step 5's short-circuit), parsed plans + EPIC blocks are ready for the write + parity gate.

#### Step 2.2c — write and deterministic parity gate (both paths)

The legacy path lands here too — the write + parity logic applies identically.

1. Write each plan based on its `epic` frontmatter field:
   - If `epic: <slug>` is set → `.soloflow/active/plans/{slug}/TASK-{NNN}-plan.md`, creating the folder if missing.
   - If `epic` absent or `null` → `.soloflow/active/plans/TASK-{NNN}-plan.md` (flat).

   Each plan's frontmatter MUST carry `status: ready` and its `depends_on` list — that frontmatter IS the queue entry. IDs are derived from the filesystem; no counter file to update. Use `wx`/noclobber semantics on write; on collision, recompute next ID for remaining plans and retry.

2. **Run the deterministic parity gate.** For each plan written in step 1, invoke:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/refiner/apply-parity.js" --plan <plan-path>
   ```
   The script wraps `ac-parity.js` and rewrites the plan's frontmatter in-place to fix any of the three parity violations:
   - `test_strategy.targets[].test_file` missing from `files_owned` → appended.
   - AC verification references a path in `files_readonly` → moved to `files_owned`.
   - AC verification references a path absent from both lists → appended to `files_owned`.

   The script emits `{ plan, corrections: [{path, action}] }` (action ∈ `test_target_added` | `readonly_to_owned` | `inserted`). It is idempotent: a plan with no violations is left byte-identical and reports zero corrections.

   Aggregate per-plan correction counts. Surface them in Step 2.3 alongside sanitizer reports. **If more than 3 plans had at least one correction in a single refinement run, flag it prominently and offer "Request changes" proactively** — that volume signals systemic refiner drift, not isolated misses.

   This gate is the structural fix for the recurring `test_file ↔ files_owned` omission class (FIND-SPRINT-008-3/4, 010-3, 012-3..8, 040-6). Earlier prose-instruction parity steps depended on agent attention and were silently skipped under load. Do NOT replace this Bash call with an in-prompt cross-check — the determinism is the point.

3. For each **new** epic slug introduced, write its `EPIC-{slug}.md` body to `.soloflow/active/plans/{slug}/EPIC-{slug}.md`. Do NOT overwrite an existing EPIC; if one exists for that slug, leave it alone (optionally append `target_id` to its `originating_ideas` frontmatter list).

### Step 2.3: Human Checkpoint — Plan Review

Present all plans to the user with:
- Task count and dependency graph.
- **Epic groupings**: for each epic slug, list its tasks and (for new epics) its objective. Call out orphan tasks separately.
- Total estimated complexity.
- Decisions made and tradeoffs resolved.
- Open questions requiring human input (if any were escalated).
- Any requirements that were dropped with reasoning.
- Any parity-gate corrections (Step 2.2c.2 — `apply-parity.js`).
- Any sanitizer reports from Step 2.2.

Use **AskUserQuestion**: `"How should we proceed with these plans?"` with options:
- **Approve all** — leave all plans `status: ready`.
- **Approve subset** — flip unapproved plans to `status: deferred` via `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/set-plan-status.js" deferred TASK-{NNN} ...`.
- **Request changes** — re-run the refiner with the user's feedback.
- **Reject** — `git rm` the plan files (plans ARE the queue entries).

The tool blocks until the user responds.

### Step 2.4: Commit state

After the user responds, commit via Bash. Stage only paths touched.

1. `git add` each plan file written (or whose frontmatter changed) plus any new/modified `EPIC-{slug}.md` files. For rejections, `git rm` the deleted plans.
2. If `git diff --cached --quiet` reports no staged changes, skip.
3. Otherwise commit with `chore: queue TASK-{NNN}..TASK-{MMM} from {target_id}` (or `chore: reject plans for {target_id}` on rejection).

Skip silently if not in a git repo or `.soloflow/` is gitignored.

### Step 2.5: Archive the source idea

Once plans are committed (approved or partially approved — not rejected), archive the source idea:

1. `mkdir -p .soloflow/archive/ideas`.
2. Move `.soloflow/active/ideas/{target_id}.md` → `.soloflow/archive/ideas/{target_id}.md`.
3. If `.soloflow/active/research/{target_id}-research.md` exists, move it to `.soloflow/archive/ideas/{target_id}-research.md`.
4. `git add` the moved files (both old and new paths). If no changes, skip.
5. Commit with `chore: archive {target_id}`.

On rejection (all plans rejected), leave the idea in `active/ideas/` for re-refinement.

Skip silently if not in a git repo or `.soloflow/` is gitignored.

### Step 2.6: Report

```
Planning complete for {target_id}.
- Tasks created: {count} (TASK-{NNN}..TASK-{NNN})
- Ready: {count} | Deferred: {count}
```

Then run **Phase 3** with `cancel = false`. After Phase 3 returns, print `Next step: /soloflow:sprint` and stop.

## Phase 2 — multi-IDEA parallel path

Runs only when `to_refine.length >= 2` AND `parallelism.task_refiner_parallel === true`. Cross-IDEA fan-out plus a single combined human checkpoint at the end.

1. **Per-IDEA setup (sequential, fast).** For each ID in `to_refine`:
   - Read `.soloflow/active/ideas/{ID}.md` content.
   - Check for `.soloflow/active/research/{ID}-research.md`. If present (e.g. for IDs not from braindump), include it with the decomposer; if absent, pass empty research.
   Discover existing epics ONCE for the whole batch: glob `.soloflow/active/plans/*/EPIC-*.md` and collect each slug + body. Same list passed to every decomposer.

2. **Decomposer fan-out.** Issue **one message containing one `Agent` tool call per IDEA** (`subagent_type: "task-decomposer"`, `model: <resolved task_decomposer>`). Each call's prompt is the standard decomposer payload from Phase 2 single-IDEA Step 2.2 parallel path step 1, scoped to its IDEA. Wait for all calls to return.

3. **Parse and validate each skeleton.** Apply the same JSON parse + validation pre-checks as Phase 2 single-IDEA Step 2.2 parallel path steps 2–3 (slot uniqueness, depends_on locality, files_owned_hint disjointness within the IDEA, epic-slug consistency). On any IDEA's decomposer failing parse twice or producing invalid skeleton: drop that IDEA from the batch, surface in the combined checkpoint as `Decomposition failed for IDEA-{NNN}`, continue with the rest.

4. **Allocate real TASK-NNN IDs across all IDEAs.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/next-ids.js" --kind task` ONCE for the batch starting counter. Walk `to_refine` in order; for each IDEA, walk its skeleton's `tasks[]` in source order and assign sequential TASK-NNN IDs. Build a per-IDEA slot→TASK map. Remap each task's `depends_on` from slot IDs to real TASK IDs using its IDEA's map. Cross-IDEA dependencies are not allowed.

5. **Detailer fan-out.** Build the prompt for each task across all IDEAs in the same shape as Phase 2 single-IDEA parallel step 6 (`MODE: detail`, `TASK_ID:`, `TASK_SKELETON:` with remapped depends_on, `SIBLING_DAG:` covering only that IDEA's siblings, IDEA body, research if present, existing-epics list). Issue **one message containing one `Agent` tool call per task across the entire batch** (`subagent_type: "task-refiner"`, `model: <resolved task_refiner>`). Wait for all calls to return.

6. **Collate per-IDEA and materialize EPIC files.** For each IDEA in the batch:
   - Collect its detailer outputs (sanitize each via `scripts/refiner/sanitize-plan.js`).
   - On `CONTEXT_LIMIT` from any detailer, respawn that one slot only with handoff (cap at resolved `limits.context_limit_respawn_max`); on terminal failure drop the slot.
   - Generate `EPIC-{slug}.md` bodies for entries in this IDEA's decomposer `new_epics[]`.

7. **Write all plans + EPIC files, then run the deterministic parity gate.** For each IDEA, write its plans to `.soloflow/active/plans/{epic}/TASK-{NNN}-plan.md` (or flat for orphans) using `wx`/noclobber. On collision, recompute next ID for remaining plans and retry. Each plan's frontmatter MUST carry `status: ready` and the remapped `depends_on`. Write each new EPIC body if not already present. Then for every written plan run `node "${CLAUDE_PLUGIN_ROOT}/scripts/refiner/apply-parity.js" --plan <path>` (Step 2.2c.2 semantics) and aggregate corrections per-plan and per-IDEA for the combined checkpoint. If more than 3 plans across the batch had at least one correction, flag prominently in step 8.

8. **Single combined human checkpoint.** Print a per-IDEA summary block first (count, dep graph, epic groupings, parity-gate auto-corrections, dropped slots, scope_drops) then use **AskUserQuestion** (single question, single-select):
   - `question`: `"How should we proceed with the {N} refined IDEAs?"`
   - `options`:
     1. `"Approve all (Recommended)"` — leave every task `status: ready`.
     2. `"Approve subset"` — follow up with a free-form `AskUserQuestion` asking which IDEA IDs (or specific TASK IDs) to defer; flip those plans' frontmatter via `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/set-plan-status.js" deferred TASK-{NNN} ...`.
     3. `"Reject all"` — `git rm` every plan file written in this batch.
     4. `"Cancel"` — leave plan files on disk but stop here without committing or archiving.

   The tool blocks until the user responds.

9. **Commit state.** Stage only specific paths touched (each plan file, each modified EPIC). Never `git add .`. If no staged changes, skip. Otherwise:
   - **Approve all** → `chore: queue TASK-{first}..TASK-{last} from refinement batch` (cite IDEA range too if useful).
   - **Approve subset** → same, plus a `deferred: TASK-X, TASK-Y` line in the body.
   - **Reject all** → `chore: reject batch plans` (the `git rm`s are already staged).
   - **Cancel** → no commit. Run **Phase 3** with `cancel = true`, then stop.

10. **Archive source IDEAs.** For every IDEA in the batch whose plans were not "Reject all"-deleted:
    - `mkdir -p .soloflow/archive/ideas`.
    - Move `.soloflow/active/ideas/{ID}.md` → `.soloflow/archive/ideas/{ID}.md`. (Move research too if present.)
    - `git add` the moved files; commit `chore: archive {first-id}..{last-id} from refinement batch` (single combined commit).

    Skip silently if not in a git repo or `.soloflow/` is gitignored.

11. **Final report.** Print:
    ```
    Refined {N} IDEAs in parallel.
    - Tasks created: {count} (TASK-{first}..TASK-{last})
    - Approved: {ready_count} | Deferred: {deferred_count} | Rejected: {rejected_count}
    ```

    Then run **Phase 3** with `cancel = (Step 8 answer === "Cancel")`. After Phase 3 returns, print `Next step: /soloflow:sprint` and stop.

---

# Phase 3 — Merge phase branch (or park on cancel)

Skip this phase entirely if `PHASE_ID` is `null` (phase_worktrees=false or Phase 0 setup failed). The work already landed on the main checkout.

Operate from `MAIN_CWD` for this entire phase. Do NOT export `SOLOFLOW_ROOT` — Phase 3 ops touch the main repo, not the worktree's state.

Takes one input: `cancel` (boolean).

### Step 3.1: Cancel path (park branch, preserve worktree)

If `cancel === true`:

1. Park the phase branch under `phase-cancelled/` so the next `settle-phase.js` sweep ignores it:

   ```bash
   git -C "$MAIN_CWD" branch -m "$PHASE_BRANCH" "phase-cancelled/planning-$PHASE_ID"
   ```

2. Print:

   ```
   Phase worktree preserved at .soloflow-worktrees/planning-{PHASE_ID}/.
   Branch parked at phase-cancelled/planning-{PHASE_ID}.
   To inspect or resume manually:
     cd .soloflow-worktrees/planning-{PHASE_ID}
   To discard:
     git -C . worktree remove --force .soloflow-worktrees/planning-{PHASE_ID}
     git -C . branch -D phase-cancelled/planning-{PHASE_ID}
   ```

3. Stop. Do NOT run the merge step.

### Step 3.2: Merge path

If `cancel === false`:

1. Verify the main checkout is still on the base branch (it should be — we never chdir'd it). Run via Bash:

   ```bash
   git -C "$MAIN_CWD" symbolic-ref --quiet --short HEAD
   ```

   Compare against `BASE_BRANCH` captured in Phase 0. If they differ, do NOT attempt the merge — print a manual-merge instruction and stop:

   ```
   Cannot auto-merge phase branch: main checkout is now on {CURRENT} but the
   phase branched from {BASE_BRANCH}. Worktree and branch preserved.
   To merge manually: git checkout {BASE_BRANCH} && git merge phase-ready/planning-{PHASE_ID}
   ```

2. Run the merge:

   ```bash
   (cd "$MAIN_CWD" && node "${CLAUDE_PLUGIN_ROOT}/scripts/state/phase-worktree-merge.js" --phase planning --id "$PHASE_ID")
   ```

   Parse the JSON output.

3. **On success** (`merge: "ff"` or `merge: "non-ff"`): print:

   ```
   Phase planning-{PHASE_ID} merged into {base_branch} ({head_sha}).
   ```

4. **On conflict** (exit code 2, `merge: "conflict"`): the merge script has already parked the branch under `phase-conflicted/planning-{PHASE_ID}` and preserved the worktree. File a `human-review-queue.md` actions item:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/state/review-queue.js" append --entry-json "{\"bucket\":\"actions\",\"type\":\"planning_phase_merge_conflict\",\"level\":\"high\",\"action\":\"Resolve merge conflict on phase-conflicted/planning-${PHASE_ID}; then run: git -C . worktree remove --force .soloflow-worktrees/planning-${PHASE_ID} && git -C . branch -D phase-conflicted/planning-${PHASE_ID}\",\"context\":\"Planner phase ${PHASE_ID} could not auto-merge into ${BASE_BRANCH}. Worktree preserved at .soloflow-worktrees/planning-${PHASE_ID}/ for inspection.\"}"
   ```

   (No `SOLOFLOW_ROOT` prefix here — review-queue should land in the main checkout's queue, since that's where the user will see it.)

   Print:

   ```
   Phase planning-{PHASE_ID} could not auto-merge. Branch parked at
   phase-conflicted/planning-{PHASE_ID}; worktree preserved for inspection.
   Filed actions item in human-review-queue.md.
   ```

5. **On any other failure** (exit code 1, removeWorktree failure, etc.): print the captured error and the worktree path; stop.

Exit points that route here:

- Phase 1a Step 1a.6 "Not yet" → `cancel = false`.
- Phase 1b Step 1b.7 "Don't refine now", or "Refine some" with empty selection → `cancel = false`.
- Phase 2 single-IDEA Step 2.6 (Approve all / Approve subset / Reject) → `cancel = false`.
- Phase 2 multi-IDEA Step 11 → `cancel = (Step 8 answer === "Cancel")`.

---

## Notes

- This command does NOT execute any tasks — that's `/soloflow:sprint`.
- Wrappers `/soloflow:idea-extractor` and `/soloflow:braindump` exist for users who prefer the focused single-purpose entry; they read this file and execute it with `--mode=single-idea` or `--mode=multi-idea` prepended to their `$ARGUMENTS`.

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
