#!/usr/bin/env bash
set -euo pipefail

# SoloFlow scaffold + repair script.
#
# This script is idempotent: running it on an already-initialized project will
# create any missing directories or state files without touching files that
# already exist. Use it as the shell fallback when you can't invoke
# /soloflow:init from inside Claude Code.

TASKS_DIR="${1:-.soloflow}"

MODE="fresh"
if [ -d "$TASKS_DIR" ]; then
  MODE="repair"
fi

# write_if_missing <path> <<EOF ... EOF
# Writes heredoc content to <path> only if the file does not already exist.
write_if_missing() {
  local path=$1
  if [ -e "$path" ]; then
    return 0
  fi
  # Read heredoc from stdin into the file.
  cat > "$path"
}

# Active state — read during execution
mkdir -p "$TASKS_DIR"/active/{ideas,research,plans,stuck,roadmaps}

# Archive — never read during execution
mkdir -p "$TASKS_DIR"/archive/{done,reviews,findings,compound,roadmaps}

# .gitkeep files so empty subdirs get tracked by git
for sub in active/ideas active/research active/plans active/stuck active/roadmaps \
           archive/done archive/reviews \
           archive/findings archive/compound archive/roadmaps; do
  [ -e "$TASKS_DIR/$sub/.gitkeep" ] || touch "$TASKS_DIR/$sub/.gitkeep"
done

# Backlog — tasks awaiting execution (written by refinement, read by execution)
write_if_missing "$TASKS_DIR/active/backlog.json" << 'EOF'
{
  "version": 2,
  "tasks": {}
}
EOF

# Sprint — active sprint state and in-flight tasks (written/read by execution)
write_if_missing "$TASKS_DIR/active/sprint.json" << 'EOF'
{
  "version": 2,
  "sprint": null,
  "tasks": {}
}
EOF

# Context restoration after compaction
write_if_missing "$TASKS_DIR/checkpoint.md" << 'EOF'
---
last_updated: null
active_sprint: null
tasks_in_flight: []
---

# Session Checkpoint

No checkpoint data yet. Updated by the pre-compact hook to preserve state across context compactions.
EOF

# Batched items for human review
write_if_missing "$TASKS_DIR/human-review-queue.md" << 'EOF'
---
pending_count: 0
items: []
---

# Human Review Queue

No items pending review.
EOF

# Findings queue — out-of-scope observations logged by executor/verifier/reviewer
# during a sprint. Consumed by the compounder at learning time.
write_if_missing "$TASKS_DIR/active/findings.md" << 'EOF'
---
pending_count: 0
last_updated: null
---

# Findings Queue

Append out-of-scope observations here during a sprint. Each entry:

```
## FIND-{sprint}-{n}
- **source:** TASK-NNN (executor|verifier|code-reviewer)
- **type:** bug | cleanup | improvement | claude-md | anti-pattern
- **severity:** low | medium | high
- **status:** open
- **location:** path/to/file.ext:line (optional)
- **description:** one-paragraph observation
- **suggested_action:** (optional)
- **resolved_by:**
```

No findings yet.
EOF

if [ "$MODE" = "fresh" ]; then
  echo "Initialized SoloFlow at $TASKS_DIR"
else
  echo "Repaired SoloFlow at $TASKS_DIR (missing directories/files created; existing files preserved)"
fi
