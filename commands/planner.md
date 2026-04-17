---
description: Turn an approved idea into execution-ready task plans
argument-hint: <IDEA-NNN>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:planner

Phase 2 of the SoloFlow pipeline. Reads an approved idea (and its research report, if present) and produces execution-ready task plans. Populates the backlog.

The target idea is: **$ARGUMENTS**

---

## Model resolution (applies to every Agent spawn below)

Before invoking the Agent tool, resolve `models.<name>` per the three-tier
recipe in [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
and pass the resolved value as the Agent tool's `model` parameter.

Mapping used in this command:
- `task-refiner` → `models.task_refiner` (fallback: `opus`)

## Limits resolution

Resolve `limits.context_limit_respawn_max` (fallback: 3) at run start and use
it wherever "Cap at 3 context-limit respawns" appears below.

## Step 0: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Load the Idea

1. Parse `$ARGUMENTS` as an idea ID (e.g., `IDEA-001`). If empty or malformed, list `.soloflow/active/ideas/` and use the **AskUserQuestion** tool to let the user pick which idea to refine — pass the discovered idea IDs as options rather than printing them as prose.
2. Read `.soloflow/active/ideas/IDEA-{NNN}.md`. If missing, report the error and stop.
3. Check for `.soloflow/active/research/IDEA-{NNN}-research.md` — if present, it will be passed to the refiner.
4. Compute the starting task counter by globbing every TASK file location (`.soloflow/active/plans/**/TASK-*-plan.md`, `.soloflow/active/stuck/**/TASK-*-stuck.md`, `.soloflow/archive/done/**/TASK-*-done.md`), extracting numeric suffixes, and taking `max + 1`. See the "ID allocation" section in the project `CLAUDE.md` for the shared recipe.
5. Discover existing epics: glob `.soloflow/active/plans/*/EPIC-*.md` and collect each epic slug (parent folder name) and `EPIC-{slug}.md` contents. Pass these to the refiner so it can reuse epics instead of duplicating them.

## Step 2: Refine

1. Spawn the **task-refiner** agent via the Agent tool with:
   - The approved idea file content
   - If a research report exists, include it with: "A research report is provided below. Use it to inform your approach selection, library choices, and to resolve open questions before doing your own research."
   - The starting task counter
   - The list of existing epics discovered in Step 1.5 (slug + `EPIC-{slug}.md` contents). Instruct: "Reuse these existing epics when a task fits their objective. Propose new epic slugs only when 2+ tasks share a coherent objective. Leave `epic` null for orphan tasks."
   - Instruction: "Refine this idea into execution-ready plans. Start task numbering at TASK-{NNN}. Output each plan file's content clearly separated. For any new epic slugs you introduce, also output an EPIC-{slug}.md block."
2. Capture the refiner's output.
   - If the task-refiner reports **CONTEXT_LIMIT**: read the `### Handoff` section to get plans produced so far. Write the completed plans to disk (same as normal flow). Spawn a **fresh task-refiner** with: the original idea, "Continue refinement from previous refiner's handoff. These tasks are already planned: {list}. Start numbering at TASK-{next}.", the handoff content, and the updated starting counter. Merge outputs. Cap at resolved `limits.context_limit_respawn_max` context-limit respawns; after that, proceed with whatever plans exist.
3. Parse the output into individual plan files and any new EPIC-{slug}.md blocks.
4. Write each plan based on its `epic` frontmatter field:
   - If `epic: <slug>` is set → write to `.soloflow/active/plans/{slug}/TASK-{NNN}-plan.md`, creating the folder if missing.
   - If `epic` is absent or `null` → write to `.soloflow/active/plans/TASK-{NNN}-plan.md` (flat, orphan).
5. For each **new** epic slug the refiner introduced, write its EPIC-{slug}.md body to `.soloflow/active/plans/{slug}/EPIC-{slug}.md`. Do NOT overwrite an existing EPIC-{slug}.md — if one already exists for that slug, leave it alone (optionally append the current idea ID to its `originating_ideas` frontmatter list).
6. Add each task to `.soloflow/active/backlog.json` with `status: "ready"` and its `depends_on` list. (Do not add `epic` to backlog entries — the JSON state stays epic-unaware; task IDs remain globally unique.) IDs are derived from the filesystem — no counter file to update. Write each plan file with `noclobber` / `wx` semantics; if a collision occurs (another parallel planner raced), recompute the next ID for the remaining plans and retry.

## Step 3: Human Checkpoint — Plan Review

Present all plans to the user with:
- Task count and dependency graph
- **Epic groupings**: for each epic slug, list its tasks and (for new epics) its objective. Call out orphan tasks separately. The user may override epic assignments before approval.
- Total estimated complexity
- Decisions made and tradeoffs resolved
- Open questions requiring human input (if any were escalated)
- Any requirements that were dropped with reasoning

Use the **AskUserQuestion** tool to present the choice. Do not list the options as plain markdown bullets — the user should see a structured picker. Ask "How should we proceed with these plans?" with these options:
- **Approve all** — leave all tasks `status: "ready"` in backlog.json
- **Approve subset** — mark unapproved plans as `status: "deferred"` in backlog.json
- **Request changes** — re-run the refiner with the user's feedback
- **Reject** — delete the plan files and remove their backlog entries

The tool call blocks until the user responds — do not proceed until it returns.

## Step 3.5: Commit state

After the user responds (approval, subset, or rejection), commit the resulting state via Bash. Stage only the specific paths touched in this run — never `git add .` / `git add -A`.

1. `git add` each plan file written (or removed) plus `.soloflow/active/backlog.json` plus any new/modified `EPIC-{slug}.md` files. For rejections, `git rm` the deleted plans.
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

Next step: /soloflow:executor
```

---

## Notes

- This command does NOT execute any tasks — that's `/soloflow:executor`.
- Config reference: `executor_retry_max`, `max_sprint_tasks` in `config/defaults.yaml` apply at execution time, not here.

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
