---
description: Quickly capture multiple ideas and tasks from a braindump session
argument-hint: "- idea one\n- idea two\n- fix the login bug"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
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

## Step 7: Report and Next Steps

Print a summary:

```
## Braindump Complete

Created:
  Ideas: IDEA-{first}..IDEA-{last} ({count})
  Tasks: TASK-{first}..TASK-{last} ({count}) — added to backlog

Next steps:
  /soloflow:planner IDEA-{NNN}          — refine an idea into tasks
  /soloflow:idea-extractor IDEA-{NNN}   — full extraction with codebase grounding
  /soloflow:sprint                     — execute ready tasks from backlog
```

If any IDEAs were created, use `AskUserQuestion` with options:

1. **Run planner on all new ideas** — the user will invoke `/soloflow:planner` for each IDEA sequentially
2. **Run planner on specific ideas** — let the user pick which IDEA IDs to refine
3. **Done for now** — stop

If only TASKs were created (no IDEAs), skip the question and just report.

On "Run planner on all new ideas" or "Run planner on specific ideas": print the exact commands the user should run, e.g.:

```
Run these commands to refine your ideas:
  /soloflow:planner IDEA-{NNN}
  /soloflow:planner IDEA-{NNN}
```

Then stop. Braindump does not invoke the planner itself — it is a pure capture tool.
