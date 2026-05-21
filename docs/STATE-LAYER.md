# State Layer

All workflow state lives in `.soloflow/` (created per-project by `scripts/init.sh`), split into active and archive. Format: markdown with YAML frontmatter.

## Layout

**`.soloflow/active/`** — read during execution:
- `roadmaps/` — roadmap files (ROADMAP-NNN.md)
- `ideas/`, `research/`, `plans/`, `stuck/` — in-flight task files
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
- `human-review-queue.md` — batched items for human review, organized into four buckets (see "Human review queue" section below)
- `config.json` — project-level overrides for every key in `config/defaults.yaml`. Read at runtime via the three-tier recipe in `CUSTOMIZATION.md#config-resolution`. Edit interactively via `/soloflow:config`. Unknown keys are preserved; nothing reads them until they're documented in `defaults.yaml`.

**Why `sprint.json` is the only JSON file:** plan frontmatter (`status: ready|deferred|in-flight|done` on each `TASK-NNN-plan.md`) is the source of truth for the queue — see `scripts/state/plan-query.js`. `sprint.json` exists only to track the in-flight set for the active sprint, which enables parallel worktree execution without merge conflicts on a shared queue file. Completed tasks are removed from `sprint.json` and their reports move to `archive/done/`.

**Plan frontmatter invariant:** every `active/plans/**/TASK-*-plan.md` must carry `status` set to one of `ready` / `deferred` / `in-flight` / `done`. Missing or unrecognized values are caught by `cruft-detect.js` Scenario 8 (`untracked_plan`).

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

**Legacy:** projects that predate the per-sprint layout may still have a single `active/findings.md`; it is migrated automatically by sprint-initiator (or concatenated into the next compound run by `/soloflow:compound`). Projects that predate the direct-to-findings sprint-code-reviewer may also have leftover `type: sprint_code_review` entries in `human-review-queue.md`; those are deprecated and surfaced by `/soloflow:review-queue` Step 8 with a one-shot cleanup command.

## Human review queue

`.soloflow/human-review-queue.md` collects items that need a human between SoloFlow runs. Every item carries an explicit `bucket` field that drives both storage layout and triage flow:

- **decisions** — judgment calls (UX/copy/scope/security tradeoffs). The human reads context and picks a direction. No agent re-verifies. Producers: verifier `HUMAN_NEEDED`, code-reviewer `SECURITY_ISSUE`, bugfix `investigation_inconclusive`.
- **actions** — operational work the human performs on systems (deploy, configure, migrate, install tooling, set env vars, resolve merge conflicts). After completion, the verifier re-runs the previously-blocked check. Producers: verifier deferred checks where the human's job is operational, verifier `config_issue`, sprint orchestrator merge conflicts and prereq fails.
- **testing** — verification only a human can do (visual flows, manual flows, ground-truth checks like "open Safari and confirm copy" or "curl /api/foo and confirm 200"). The human's confirmation IS the verification — no agent re-runs. Producers: verifier deferred checks at `level: visual` or with verify-style action verbs.
- **deferred_visual** — visual verification failures the user explicitly chose to defer in `/soloflow:review-queue` Step 5 instead of promoting to a TASK immediately. Holding area before promotion or re-test. Producer: review-queue command itself.

**File format.** Frontmatter holds `pending_count` (sum across the four buckets, excluding `overridden`) and a `buckets:` map with per-bucket counts. The body has the four sections under fixed `## Decisions / ## Actions / ## Testing / ## Deferred Visual` headings; empty sections render `_No items._`. Each item is a YAML list entry under its section heading. Soft-deleted (`type: overridden`) entries live under a `## Overridden` section so round-trip parsing preserves them.

**Legacy fallback.** Pre-bucket queues (a flat YAML list directly under `# Human Review Queue`) parse fine — the library auto-classifies each entry by `type` / `level` / `action` verb. The next mutating call (append/remove/override/recompute) rewrites the file in the new sectioned format with explicit `bucket` fields.

**Tooling.** All access goes through `scripts/state/review-queue.js` — never hand-edit during agent runs. Subcommands: `gather`, `append`, `remove`, `override`, `recompute`. `--bucket` filters `remove` and `gather --group-by action`. See `commands/review-queue.md` for the triage UX.

## Epics

Tasks may optionally be grouped into epics via nested folders: `plans/<epic>/TASK-NNN-plan.md`, `stuck/<epic>/TASK-NNN-stuck.md`, `done/<epic>/TASK-NNN-done.md`. Each epic folder contains an `EPIC-<epic>.md` manifest (objective, scope, success signal) authored by the task-refiner when the epic is first created.

Epics are **optional** — orphan tasks live flat at the state-root level (e.g. `plans/TASK-NNN-plan.md`), and a single idea may produce tasks across multiple epics + orphans. Task IDs remain **globally unique**; `sprint.json` is epic-unaware (plan frontmatter's `epic` field carries the slug directly).

The source of truth for a task's epic is its plan frontmatter `epic: <slug>` field (absent/null for orphans); the folder is a convenience mirror. When all tasks in an epic complete, the executor prompts the user to archive the epic (moves `EPIC-<epic>.md` to `archive/done/<epic>/` and flips its status to `complete`); archival is never automatic.
