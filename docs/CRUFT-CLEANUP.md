# State Cruft Cleanup

Shared procedure for detecting and resolving `.soloflow/` state cruft. Followed by `/soloflow:review-queue` (Step 1) and `/soloflow:housekeeping`. Centralized here so both commands stay in sync.

## Preconditions

- `.soloflow/` exists (caller verifies before invoking this procedure).
- `.soloflow/active/sprint.json` may be absent — Scenarios 2 and 4 skip gracefully when it is.
- Caller initializes `cruft_resolved = 0` in its own scope and reads it back after this procedure returns (this procedure increments it in place).
- Caller chooses a short `<command>` label used in commit messages so `git log` shows which entrypoint ran the sweep. `/soloflow:review-queue` passes `review-queue`; `/soloflow:housekeeping` passes `housekeeping`.

## Step A — Detect

Run the deterministic cruft detector — read-only, no mutations:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state/cruft-detect.js"
```

The script returns JSON with seven per-scenario buckets plus a `total`. Each scenario's proposed resolution is applied in Step C:

- **`orphan_plan`** — plan in `active/plans/` while a matching done report exists in `archive/done/`. Resolution: delete the plan file.
- **`ghost_sprint_entry`** — sprint.json task in `stuck`/`blocked`/`human_needed` with no plan or stuck file on disk. Resolution: per-item prompt (synthesize a stub stuck report, or `settle-task.js blocked` with a note).
- **`stale_stuck_file`** — stuck file whose task is not in `sprint.json`. If a done report exists, move stuck file to `.soloflow/archive/stuck/`; otherwise prompt (archive or delete).
- **`mid_commit_settle`** — done report exists AND task still in `sprint.json.tasks`. Resolution: re-run `settle-task.js TASK-{NNN} done --done-report <path>` (finalizes the state transition + commits).
- **`empty_epic`** — epic folder with no `TASK-*-plan.md` files AND no tasks in `sprint.json.tasks` matching the folder slug. Resolution: move `EPIC-<slug>.md` → `.soloflow/archive/done/<slug>/EPIC-<slug>.md` and flip its frontmatter `status` to `complete`.
- **`malformed_queue`** — queue entries missing required fields (`task`, `type`). Resolution: surface at end of Step B for manual edit — do not auto-repair.
- **`completed_in_backlog`** — done report exists in `archive/done/` AND task is still listed in `backlog.json.tasks`. Resolution: delete the task entry from `backlog.json` and commit.

If `total` is 0, print `"No cruft detected."` and return immediately.

## Step B — Present + decide

Walk through each non-empty bucket sequentially. For each bucket use **one `AskUserQuestion`** with the full item list **embedded in the question text** (text printed before AskUserQuestion gets cut off by the question UI):

```
Cruft — {scenario name} ({N} items):
  1. TASK-NNN — {short description of the cruft}
  2. TASK-MMM — ...
Resolve?
```

Options (all buckets):

- **Resolve all** — apply the proposed action to every item.
- **Resolve some** — follow-up free-form `AskUserQuestion` for a comma-separated item list (e.g., `1, 3`); unlisted items left alone.
- **Skip bucket** — leave everything as-is.
- **Review each** — loop with one `AskUserQuestion` per item (options: **Resolve** / **Skip**).

For Scenario 6 (`malformed_queue`), print the offending entries verbatim and ask **Edit manually now** / **Skip and continue** — do not try to auto-repair.

## Step C — Apply + commit

Apply resolutions as they are approved. All commits go through `commit-atomic.js` (explicit paths, skip-if-not-repo, never `-A`). Substitute `<command>` with the label the caller passed in.

- **Orphan plan delete (Scenario 1):** `rm <plan-path>`, then
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/commit-atomic.js" --message "chore: <command> — orphan plan: TASK-{NNN}" --path <plan-path>` (one per item).
- **Ghost sprint entry (Scenario 2):**
  - "Synthesize stub": write `.soloflow/active/stuck/TASK-{NNN}-stuck.md` with a short frontmatter + body (status: unknown, source: `<command>` cruft sweep), then `settle-task.js TASK-{NNN} stuck --stuck-report .soloflow/active/stuck/TASK-{NNN}-stuck.md`.
  - "Mark blocked": `update-task-status.js TASK-{NNN} blocked --note "cruft sweep — no plan/stuck file found"`.
- **Stale stuck file (Scenario 3):** `mkdir -p .soloflow/archive/stuck && git mv .soloflow/active/stuck/TASK-{NNN}-stuck.md .soloflow/archive/stuck/`, then `commit-atomic.js --message "chore: <command> — archive stale stuck: TASK-{NNN}" --path .soloflow/active/stuck/TASK-{NNN}-stuck.md --path .soloflow/archive/stuck/TASK-{NNN}-stuck.md`. If user chose delete instead: `rm` + `commit-atomic.js ... --path <rm-path>`.
- **Mid-commit settle crash (Scenario 4):** `settle-task.js TASK-{NNN} done --done-report <done-report-path>` — this self-commits.
- **Empty epic (Scenario 5):** `mkdir -p .soloflow/archive/done/<slug>`, edit `EPIC-<slug>.md`'s frontmatter `status` → `complete`, `git mv .soloflow/active/plans/<slug>/EPIC-<slug>.md .soloflow/archive/done/<slug>/EPIC-<slug>.md`. `rmdir` the empty epic folder. Then `commit-atomic.js --message "chore: <command> — archive epic: <slug>" --path <src> --path <dest>`.
- **Completed in backlog (Scenario 7):** Read `.soloflow/active/backlog.json`, delete the `tasks["TASK-{NNN}"]` entry (Read + Edit), write the file back. Then `commit-atomic.js --message "chore: <command> — backlog cruft: TASK-{NNN}" --path .soloflow/active/backlog.json`. One commit per item.

Commit rules for the whole procedure:

- One commit per resolved item (per-item atomicity survives mid-run abort).
- Increment `cruft_resolved` per applied item.
- Skip commits silently if the project is not a git repo or `.soloflow/` is gitignored (handled by `commit-atomic.js`).
- Never `git add .` or `-A`. Every commit stages only explicit paths.
