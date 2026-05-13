---
description: Summarize the backlog as a one-line-per-task roadmap, grouped by epic
allowed-tools: [Read, Glob, Bash]
---

# /soloflow:summarize-roadmap

Print the current state of the backlog as a roadmap-style report: one line per active task, grouped by epic, with totals at the bottom. Read-only — no state mutations, no agent spawns.

## Steps

1. **Check initialization.** If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

2. **Fetch all active tasks.** Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/state/plan-query.js" --format json
   ```
   With no filters, this returns every task under `.soloflow/active/plans/**/TASK-*-plan.md` as a JSON array. Each element carries the task's frontmatter (`id`, `title`, `status`, `epic`, `depends_on`, `scope_summary`, `plan_path`).

3. **Empty-state.** If the result is `[]`, print and stop:

   ```
   ## Roadmap Summary

   No active tasks. Use `/soloflow:idea-extractor` or `/soloflow:roadmap` to seed the backlog.
   ```

4. **Group by epic.** Bucket tasks by their `epic` frontmatter field. Treat `null`, missing, or empty-string as the `Orphans (no epic)` bucket. Sort non-orphan buckets alphabetically by slug; the orphans bucket goes last. Within each bucket, sort tasks by `id` ascending.

5. **Resolve epic heading.** For each non-orphan slug:
   - Try `Read` on `.soloflow/active/plans/<slug>/EPIC-<slug>.md`.
   - If not found, try `.soloflow/archive/done/<slug>/EPIC-<slug>.md`.
   - If found, parse frontmatter and use `objective` as the heading text and `status` as the parenthetical badge.
   - If neither is found or `objective` is absent, fall back to the slug itself as the heading and omit the status badge.

6. **Format the report.** Per-task line:
   ```
   - [<status>] TASK-NNN — <title>
   ```
   The task's `title` field is the one-sentence summary. Use raw status values (`ready`, `deferred`, `pending`, `in_progress`, `blocked`, `stuck`, `human_needed`).

   Add an indented `↳ blocked by: TASK-A, TASK-B` line **only when** the task's `status` is `blocked` AND `depends_on` is a non-empty list.

7. **Display the report:**

   ```
   ## Roadmap Summary

   ### Epic: <objective-or-slug>  (<epic-status>) — <slug>
   - [ready] TASK-012 — Add JWT refresh endpoint
   - [in_progress] TASK-014 — Wire refresh into middleware
   - [blocked] TASK-019 — Rotate signing keys on schedule
     ↳ blocked by: TASK-014

   ### Epic: <next-objective>  (<epic-status>) — <slug>
   - …

   ### Orphans (no epic)
   - [ready] TASK-021 — Bump axios to 1.7.x

   ### Totals
   - **Active tasks:** N
   - **Epics with active work:** M
   - **By status:** ready N · in_progress N · blocked N · stuck N · human_needed N · deferred N · pending N
   ```

   Omit the `### Orphans (no epic)` section if there are zero orphan tasks. In the **By status** line, omit any status with count 0 to keep it scannable.
