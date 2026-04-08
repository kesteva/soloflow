---
description: Initialize the .soloflow/ state directory in this project
allowed-tools: [Read, Write, Bash]
---

# /soloflow:init

Scaffolds the `.soloflow/` state directory that every other SoloFlow command
depends on. Run this once per project, after installing the plugin, before
using any other `/soloflow:*` command.

---

## Step 1: Check for existing state

Run `ls .soloflow 2>/dev/null` via Bash.

- If the directory already exists, report:
  ```
  SoloFlow is already initialized in this project. Nothing to do.
  ```
  and stop.

## Step 2: Create the directory tree

Create these directories (use `mkdir -p` via Bash):

- `.soloflow/active/ideas`
- `.soloflow/active/research`
- `.soloflow/active/plans`
- `.soloflow/active/stuck`
- `.soloflow/archive/done`
- `.soloflow/archive/reviews`
- `.soloflow/archive/solutions`

Write an empty `.gitkeep` file into each of the seven subdirectories above so
git tracks them while they're empty.

## Step 3: Write state files

Use the Write tool to create each of these files with the exact contents shown.

**`.soloflow/active/backlog.json`**
```json
{
  "version": 2,
  "tasks": {}
}
```

**`.soloflow/active/sprint.json`**
```json
{
  "version": 2,
  "sprint": null,
  "tasks": {}
}
```

**`.soloflow/counters.json`**
```json
{
  "ideas": 0,
  "tasks": 0,
  "sprints": 0,
  "solutions": 0
}
```

**`.soloflow/checkpoint.md`**
```markdown
---
last_updated: null
active_sprint: null
tasks_in_flight: []
---

# Session Checkpoint

No checkpoint data yet. Updated by the pre-compact hook to preserve state across context compactions.
```

**`.soloflow/human-review-queue.md`**
```markdown
---
pending_count: 0
items: []
---

# Human Review Queue

No items pending review.
```

## Step 4: Stage in git (if applicable)

Run `git rev-parse --is-inside-work-tree` via Bash. If the project is inside
a git repo AND `.soloflow/` is not gitignored (`git check-ignore -q .soloflow`
returns non-zero), run `git add .soloflow` so task/idea history is tracked
going forward. Do not commit — leave the files staged for the user to commit
on their own.

If the project isn't a git repo, skip this step silently.

## Step 5: Report

Tell the user:

```
Initialized .soloflow/ in this project.

Next steps:
  /soloflow:idea-extractor "<description>"   — start the full pipeline
  /soloflow:quick "<bug description>"        — fast path for bugfixes
  /soloflow:status                           — check current state
```
