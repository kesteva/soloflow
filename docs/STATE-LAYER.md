# State Layer

All workflow state lives in `.soloflow/` (created per-project by `scripts/init.sh`), split into active and archive. Format: markdown with YAML frontmatter.

## Layout

**`.soloflow/active/`** — read during execution:
- `roadmaps/` — roadmap files (ROADMAP-NNN.md)
- `ideas/`, `research/`, `plans/`, `stuck/` — in-flight task files
- `backlog.json` — tasks awaiting execution (written by refinement, read by execution)
- `sprint.json` — active sprint + in-flight tasks (written/read by execution)
- `findings/SPRINT-NNN-findings.md` — append-only queue of out-of-scope observations for a specific sprint, logged by executor / verifier / code-reviewer. Sprint-initiator creates the file at sprint start; it stays in `active/findings/` after sprint close and is archived by `/soloflow:compound` after that sprint is compounded. Multiple sprints' findings files can coexist (compound backlog).
- `compound/SPRINT-NNN-proposal.md` (single sprint) or `compound/SPRINT-{MIN}-{MAX}-proposal.md` (merged batch) — transient compound proposal written by the compounder during `/soloflow:compound`, archived after the user approves/rejects items. Span-named files cover multiple sprints (frontmatter `sprints:` array is canonical membership; the filename is a label).
- `sprint-code-review.md` — transient file written by the sprint-code-reviewer at Step 3.6; read by the sprint-closer's gather phase and archived to `archive/sprint-code-reviews/` at sprint close.

**`.soloflow/archive/`** — never read during execution:
- `ideas/` — ideas that have been refined into plans (moved from `active/ideas/` by the planner)
- `done/`, `reviews/` — completed task reports and learnings
- `findings/` — archived findings files, one per compounded sprint (always per-sprint, even when a merged compound consumed them together)
- `compound/` — archived compound proposals (including rejected items); files may be single-sprint (`SPRINT-NNN-proposal.md`) or merged-batch (`SPRINT-{MIN}-{MAX}-proposal.md`)
- `roadmaps/` — archived roadmap files

**`.soloflow/` root:**
- `checkpoint.md` — context restoration after compaction
- `human-review-queue.md` — batched items for human review
- `config.json` — project-level overrides for every key in `config/defaults.yaml`. Read at runtime via the three-tier recipe in `CUSTOMIZATION.md#config-resolution`. Edit interactively via `/soloflow:config`. Unknown keys are preserved; nothing reads them until they're documented in `defaults.yaml`.

**Why two JSON files (backlog, sprint):** enables parallel worktree execution without merge conflicts. Completed tasks are removed from `sprint.json` and their reports move to `archive/done/`.

**`backlog.json` invariant:** only contains tasks with `status: ready` or `status: deferred`. Completed tasks are removed by `settle-task.js` on the `done` verdict; any stale entry that slips past (crash between writes, hand-edit) is caught by `cruft-detect.js` Scenario 7 (`completed_in_backlog`).

## ID allocation

`IDEA-NNN`, `TASK-NNN`, `SPRINT-NNN`, and `ROADMAP-NNN` are derived from the filesystem — there is no `counters.json`. To allocate the next ID, glob every location an ID of that kind could live, extract the numeric suffix, take `max + 1`, zero-pad to 3 digits.

**Reference globs:**
- **IDEA:** `.soloflow/active/ideas/IDEA-*.md` ∪ `.soloflow/archive/ideas/IDEA-*.md`
- **TASK:** `.soloflow/active/plans/**/TASK-*-plan.md` ∪ `.soloflow/active/stuck/**/TASK-*-stuck.md` ∪ `.soloflow/archive/done/**/TASK-*-done.md`
- **SPRINT:** `.soloflow/archive/compound/SPRINT-*-proposal.md` ∪ `.soloflow/archive/findings/SPRINT-*-findings.md` ∪ `.soloflow/active/findings/SPRINT-*-findings.md` ∪ `.soloflow/active/compound/SPRINT-*-proposal.md` ∪ the active `sprint.json`'s `sprint.id` (pending sprints live in `active/findings/` until compounded). Span-named proposals like `SPRINT-001-003-proposal.md` contain multiple numeric runs in the basename; the recipe below extracts EVERY numeric run per file to compute the true max.
- **ROADMAP:** `.soloflow/active/roadmaps/ROADMAP-*.md` ∪ `.soloflow/archive/roadmaps/ROADMAP-*.md`

**Recipe (bash):**

```bash
next_id() {
  local prefix=$1; shift
  local max=0
  for p in "$@"; do
    for f in $(compgen -G "$p" 2>/dev/null); do
      local b=$(basename "$f")
      # Skip filenames whose first char after the prefix is non-numeric
      # (e.g., SPRINT-quick-<timestamp>) so unrelated numbers like
      # timestamps never contaminate the max.
      case "$b" in "${prefix}-"[0-9]*) ;; *) continue ;; esac
      # Extract every numeric run in the basename and track the max
      # across all of them. Required for span-named files like
      # SPRINT-001-003-proposal.md where 003 (not 001) is the true max.
      for n in $(echo "$b" | grep -oE '[0-9]+'); do
        n=$(echo "$n" | sed 's/^0*//'); n=${n:-0}
        [ "$n" -gt "$max" ] && max=$n
      done
    done
  done
  printf "%03d" $((max + 1))
}
```

**Collision handling.** When two parallel workers compute the same "next ID," the second writer must fail-fast on write and retry. In bash, use `set -o noclobber` + `> file` (or `: > file`) which errors if the file exists; in Node, `fs.writeFileSync(path, data, { flag: 'wx' })`; via a slash command, check `test -e` and retry with `max+1` if it exists. Never overwrite an existing ID file.

## Findings queue (per-sprint)

Executor / verifier / code-reviewer / **sprint-code-reviewer** agents append entries to the active sprint's findings file (`.soloflow/active/findings/{sprint.id}-findings.md`, resolved from `sprint.json`) whenever they notice something out of scope for their current task (a bug elsewhere, stale docs, a CLAUDE.md gap). They never expand scope to fix it. Sprint-code-reviewer findings (cross-task duplication, redundancy, security drift) flow here as well — they are not routed through `human-review-queue.md` and the user is not prompted to triage them at sprint close.

The compounder consumes the sprint's findings file at learning time and uses it as the primary seed for clean-up, backlog, and CLAUDE.md proposals; the file is archived to `archive/findings/` only after that sprint is compounded. Findings files are always per-sprint — merging across sprints happens only at compounder invocation when `/soloflow:compound` batches multiple pending sprints, and each findings file still archives individually to `archive/findings/SPRINT-NNN-findings.md`.

**Legacy:** projects that predate the per-sprint layout may still have a single `active/findings.md`; it is migrated automatically by sprint-initiator (or concatenated into the next compound run by `/soloflow:compound`). Projects that predate the direct-to-findings sprint-code-reviewer may also have leftover `type: sprint_code_review` entries in `human-review-queue.md`; those are deprecated and surfaced by `/soloflow:review-queue` Step 7 with a one-shot cleanup command.

## Epics

Tasks may optionally be grouped into epics via nested folders: `plans/<epic>/TASK-NNN-plan.md`, `stuck/<epic>/TASK-NNN-stuck.md`, `done/<epic>/TASK-NNN-done.md`. Each epic folder contains an `EPIC-<epic>.md` manifest (objective, scope, success signal) authored by the task-refiner when the epic is first created.

Epics are **optional** — orphan tasks live flat at the state-root level (e.g. `plans/TASK-NNN-plan.md`), and a single idea may produce tasks across multiple epics + orphans. Task IDs remain **globally unique**; `backlog.json` / `sprint.json` are epic-unaware.

The source of truth for a task's epic is its plan frontmatter `epic: <slug>` field (absent/null for orphans); the folder is a convenience mirror. When all tasks in an epic complete, the executor prompts the user to archive the epic (moves `EPIC-<epic>.md` to `archive/done/<epic>/` and flips its status to `complete`); archival is never automatic.
