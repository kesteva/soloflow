#!/usr/bin/env bash
set -euo pipefail

TASKS_DIR="${1:-.soloflow}"

if [ -d "$TASKS_DIR" ]; then
  echo "SoloFlow already initialized at $TASKS_DIR"
  exit 0
fi

# Active state — read during execution
mkdir -p "$TASKS_DIR"/active/{ideas,research,plans,stuck}

# Archive — never read during execution
mkdir -p "$TASKS_DIR"/archive/{done,reviews,solutions}

# Backlog — tasks awaiting execution (written by refinement, read by execution)
cat > "$TASKS_DIR/active/backlog.json" << 'EOF'
{
  "version": 2,
  "tasks": {}
}
EOF

# Sprint — active sprint state and in-flight tasks (written/read by execution)
cat > "$TASKS_DIR/active/sprint.json" << 'EOF'
{
  "version": 2,
  "sprint": null,
  "tasks": {}
}
EOF

# Counters — global ID counters (separate file to minimize merge conflicts)
cat > "$TASKS_DIR/counters.json" << 'EOF'
{
  "ideas": 0,
  "tasks": 0,
  "sprints": 0,
  "solutions": 0
}
EOF

# Context restoration after compaction
cat > "$TASKS_DIR/checkpoint.md" << 'EOF'
---
last_updated: null
active_sprint: null
tasks_in_flight: []
---

# Session Checkpoint

No checkpoint data yet. Updated by the pre-compact hook to preserve state across context compactions.
EOF

# Batched items for human review
cat > "$TASKS_DIR/human-review-queue.md" << 'EOF'
---
pending_count: 0
items: []
---

# Human Review Queue

No items pending review.
EOF

echo "Initialized SoloFlow at $TASKS_DIR"
