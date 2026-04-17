---
description: Generate a phased roadmap from a project vision, with deep questioning, parallel research, and epic generation
argument-hint: <vision description | --resume ROADMAP-NNN>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:roadmap

Phase 0 of the SoloFlow pipeline. Turns a high-level project vision into a phased roadmap of epics, then materializes them as ideas (for normal pipeline) or plans (for immediate execution).

The user's input is: **$ARGUMENTS**

---

## Model resolution (applies to every Agent spawn below)

Before invoking the Agent tool, resolve `models.<name>` per the three-tier
recipe in [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
and pass the resolved value as the Agent tool's `model` parameter.

Mapping used in this command:
- `roadmap-researcher` → `models.roadmap_researcher` (fallback: `sonnet`)
- `roadmap-generator` → `models.roadmap_generator` (fallback: `opus`)
- `task-refiner` → `models.task_refiner` (fallback: `opus`)

## Step 0: Initialize

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Deep Questioning

1. **Resume check:** If `$ARGUMENTS` matches `--resume ROADMAP-NNN` (e.g., `--resume ROADMAP-003`), read `.soloflow/active/roadmaps/ROADMAP-{NNN}.md`. If found, skip to Step 4. If not found, report: "ROADMAP-{NNN} not found in active roadmaps." and stop.

2. **Skip-clarify check:** If `$ARGUMENTS` contains the literal token `--skip-clarify`, set `clarify_enabled = false` and strip the token from `$ARGUMENTS`. Otherwise:
   - If `.soloflow/config.json` exists and contains `phases.roadmap_clarify === false`, set `clarify_enabled = false`.
   - Else if `config/defaults.yaml` (via `${CLAUDE_PLUGIN_ROOT}`) has `phases.roadmap_clarify: false`, set `clarify_enabled = false`.
   - Otherwise `clarify_enabled = true`.

3. If `clarify_enabled` is false, set `brief = $ARGUMENTS` and proceed to Step 2.

4. Read `${CLAUDE_PLUGIN_ROOT}/skills/clarify-roadmap/SKILL.md` via the `Read` tool and apply its **"When to invoke"** 8-point checklist against `$ARGUMENTS`. The checklist covers: vision, target users, constraints, success metrics, technical preferences, scope boundary, phasing priorities, risk tolerance.

5. If every checklist item is satisfied, the input is already clear -- set `brief = $ARGUMENTS` and proceed to Step 2 without running the loop.

6. Otherwise, run the clarification routine defined in the skill:
   - Honor the scope-decomposition gate first (if the vision spans multiple independent products, pick one via `AskUserQuestion`).
   - Run the clarification loop: one `AskUserQuestion` at a time, preferring multi-choice, following threads, until the 8-point checklist is satisfied.
   - Present the skill's hard-gated readiness prompt ("Ready to generate the roadmap?" -- Generate roadmap / Keep clarifying / Cancel). Loop on "Keep clarifying." Stop the whole command on "Cancel."
   - On "Generate roadmap," assemble the **roadmap brief** (raw input + transcript + synthesis sections) exactly as the skill specifies, and set `brief` to that markdown block.

## Step 2: Parallel Research

1. Allocate the next roadmap ID:
   - Glob `.soloflow/active/roadmaps/ROADMAP-*.md` and `.soloflow/archive/roadmaps/ROADMAP-*.md`
   - Extract numeric suffixes, take `max + 1`, zero-pad to 3 digits
   - If no existing roadmaps, start at `ROADMAP-001`

2. Resolve the research dimensions to run:
   - If `.soloflow/config.json` has `roadmap.research_dimensions`, use that list.
   - Else use `config/defaults.yaml`'s `roadmap.research_dimensions`.
   - Fallback: `[ecosystem, user-needs, architecture, risks]`.

3. Spawn one **roadmap-researcher** agent per dimension, **all in parallel** via the Agent tool. Each agent receives:
   - The roadmap brief
   - Its dimension assignment (e.g., "Your dimension is: ecosystem")
   - The roadmap ID (e.g., "ROADMAP-003")
   - Instruction: "Research this dimension for roadmap generation. Output the complete research report."

4. Collect all research reports.
   - If any researcher reports **CONTEXT_LIMIT**: read its `### Handoff` section. Spawn a **fresh roadmap-researcher** for the same dimension with: "Continue research from previous researcher's handoff: {handoff section}". Cap at 3 respawns per dimension.

5. Write each report to `.soloflow/active/research/ROADMAP-{NNN}-research-{dimension}.md`. Use the Write tool -- these files are new, not appending to existing files.

## Step 3: Roadmap Generation

1. Discover existing epics by globbing `.soloflow/active/plans/*/EPIC-*.md`. Read each to build a list of existing epic slugs and their objectives.

2. Spawn the **roadmap-generator** agent via the Agent tool with:
   - The roadmap brief
   - All research reports (pass the content, not just paths)
   - The existing epics list (slugs + objectives + status)
   - The roadmap ID
   - Instruction: "Generate a phased roadmap with epics. Use the provided roadmap ID. Output the complete ROADMAP file content."

3. Capture the generator's output.
   - If the generator reports **CONTEXT_LIMIT**: read the `### Handoff` section. Spawn a **fresh roadmap-generator** with the original inputs + "Continue from previous generator's handoff: {handoff section}". Cap at 3 respawns.

4. Write to `.soloflow/active/roadmaps/ROADMAP-{NNN}.md` using noclobber semantics. If the target already exists (collision), recompute the next ID and retry.

## Step 4: Human Checkpoint -- Roadmap Review

1. Read the roadmap file. Present a prose summary to the user:
   - Title and vision
   - Phase count and epic count
   - For each phase: name, milestone, epic titles with complexity
   - Dependency summary (which epics depend on which)
   - Key risks (top 3)
   - Key decisions (top 3)
   - Dropped scope (if any)

2. Use `AskUserQuestion`:
   - **Question:** "How would you like to proceed with this roadmap?"
   - **Header:** "Roadmap action"
   - **Options:**
     - "Approve as ideas -- each epic becomes an IDEA for the normal pipeline (clarify -> research -> refine)"
     - "Approve as plans -- each epic becomes tasks ready for execution (faster, uses roadmap research)"
     - "Approve subset -- pick which phases/epics to include"
     - "Adjust -- give feedback to regenerate"
     - "Reject -- discard this roadmap"

3. Handle responses:

   **"Adjust":**
   - Use `AskUserQuestion` to collect feedback: "What should change?"
   - Re-run Step 3 with the feedback appended to the roadmap brief: "The user reviewed the initial roadmap and requested changes: {feedback}. Regenerate incorporating this feedback."
   - Return to Step 4 to re-present.

   **"Approve subset":**
   - List all phases and their epics. Use `AskUserQuestion` with multi-select:
     - "Which phases do you want to include?" with each phase as an option.
   - Mark non-selected phases as `status: deferred` in the roadmap frontmatter.
   - Then ask the materialization question: "Create the selected epics as ideas or plans?" with options "As ideas" / "As plans".
   - Proceed to Step 5 with only the approved phases.

   **"Reject":**
   - Delete `.soloflow/active/roadmaps/ROADMAP-{NNN}.md`
   - Delete `.soloflow/active/research/ROADMAP-{NNN}-research-*.md`
   - Report: "Roadmap ROADMAP-{NNN} rejected and deleted." and stop.

   **"Approve as ideas" or "Approve as plans":**
   - Proceed to Step 5.

## Step 5: Materialize

### Path A: Approve as ideas

1. Compute the starting IDEA ID by globbing `.soloflow/active/ideas/IDEA-*.md` and `.soloflow/archive/ideas/IDEA-*.md`, extracting numeric suffixes, taking `max + 1`.

2. For each approved epic in phase order, create an `IDEA-{NNN}.md` file directly (no agent spawn needed -- the roadmap already has enough detail):

   ```yaml
   ---
   id: IDEA-{NNN}
   type: FEATURE
   status: draft
   created: {ISO timestamp}
   roadmap: ROADMAP-{NNN}
   roadmap_phase: "{phase name}"
   roadmap_epic: "{epic slug}"
   slices:
     - title: "{scope item}"
       description: "{from epic scope}"
       value_statement: "{derived from epic objective}"
   open_questions: []
   assumptions: []
   research_recommendation: not_needed
   research_rationale: "Research already performed at roadmap level (see ROADMAP-{NNN} research reports)"
   ---

   # {Epic Title}

   ## Raw Input

   Generated from ROADMAP-{NNN}, Phase "{phase name}", Epic "{epic slug}".

   ## Grounding

   See roadmap research reports:
   - .soloflow/active/research/ROADMAP-{NNN}-research-ecosystem.md
   - .soloflow/active/research/ROADMAP-{NNN}-research-user-needs.md
   - .soloflow/active/research/ROADMAP-{NNN}-research-architecture.md
   - .soloflow/active/research/ROADMAP-{NNN}-research-risks.md

   ## Slices

   {Each scope item from the epic, expanded into a slice description}

   ## Open Questions

   None -- vision clarified during roadmap generation.

   ## Assumptions

   None -- validated during roadmap research.
   ```

3. Write each idea to `.soloflow/active/ideas/IDEA-{NNN}.md` with noclobber semantics. If collision, recompute next ID and retry.

4. Collect the list of created idea IDs.

5. Update the roadmap file's frontmatter:
   - Set `status: materialized`
   - Set `materialized_at: {ISO timestamp}`
   - Set `materialized_as: ideas`
   - Set `idea_ids: [IDEA-NNN, IDEA-NNN, ...]`
   - For each epic in the phases, set `idea_id: IDEA-NNN` (backlink)

### Path B: Approve as plans

1. Compute the starting IDEA ID and starting TASK ID from the filesystem (same glob recipes as Path A for ideas, and the standard TASK glob for tasks).

2. For each approved epic in phase order:

   a. Create a brief IDEA file (same format as Path A) for traceability. Write to `.soloflow/active/ideas/`.

   b. Spawn the **task-refiner** agent via the Agent tool with:
      - The idea file content
      - Prefix: "A research report is provided below. Use it to inform approach selection, library choices, and resolve open questions before doing your own research."
      - The relevant research reports (all 4 dimension reports)
      - The starting task counter (TASK-{NNN})
      - The existing epics list (including any epics created by earlier iterations in this loop)
      - Instruction: "Refine this idea into execution-ready plans. Start task numbering at TASK-{NNN}. Output each plan file's content clearly separated. For any new epic slugs, also output an EPIC-{slug}.md block."

   c. Parse the refiner output into individual plan files + EPIC-{slug}.md blocks.

   d. For each plan:
      - If `epic: <slug>` -> write to `.soloflow/active/plans/{slug}/TASK-{NNN}-plan.md` (create folder if missing)
      - If `epic: null` or absent -> write to `.soloflow/active/plans/TASK-{NNN}-plan.md`
      - Use noclobber semantics

   e. For each new epic: write `EPIC-{slug}.md` to `.soloflow/active/plans/{slug}/EPIC-{slug}.md` (do NOT overwrite existing)

   f. Add each task to `.soloflow/active/backlog.json` with `status: "ready"` and `depends_on` list.

   g. Update the starting task counter for the next epic iteration.

3. Update the roadmap file's frontmatter:
   - Set `status: materialized`
   - Set `materialized_at: {ISO timestamp}`
   - Set `materialized_as: plans`
   - Set `idea_ids: [...]` and `task_ids: [...]`
   - For each epic, set `idea_id: IDEA-NNN` (backlink)

## Step 5.5: Commit state

1. Stage only the specific files created/modified:
   - `.soloflow/active/roadmaps/ROADMAP-{NNN}.md`
   - `.soloflow/active/research/ROADMAP-{NNN}-research-*.md`
   - All created idea files (`.soloflow/active/ideas/IDEA-*.md`)
   - If Path B: all created plan files, EPIC-{slug}.md files, `.soloflow/active/backlog.json`

2. Commit:
   - If materialized as ideas: `chore: generate ROADMAP-{NNN} and materialize as ideas`
   - If materialized as plans: `chore: generate ROADMAP-{NNN} and materialize as plans`
   - If rejected (already handled in Step 4): no commit needed

3. Skip if not in a git repo or `.soloflow/` is gitignored.

## Step 6: Report

```
Roadmap generated: ROADMAP-{NNN} ({title})
  Phases: {count}  |  Epics: {count} ({approved} approved, {deferred} deferred)
  Research: {dimension_count} reports in .soloflow/active/research/

{If materialized as ideas:}
  Ideas created: IDEA-{first}..IDEA-{last}

  Next steps:
    /soloflow:planner IDEA-{NNN}   -- refine each idea into tasks
    /soloflow:status               -- check current state

{If materialized as plans:}
  Tasks created: TASK-{first}..TASK-{last}
  Added to backlog: {count} tasks ({ready} ready)

  Next step: /soloflow:executor
```

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
