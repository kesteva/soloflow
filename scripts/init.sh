#!/usr/bin/env bash
set -euo pipefail

TASKS_DIR="${1:-.tasks}"

if [ -d "$TASKS_DIR" ]; then
  echo "SoloFlow already initialized at $TASKS_DIR"
  exit 0
fi

# Active state — read during execution
mkdir -p "$TASKS_DIR"/active/{ideas,plans,stuck}

# Archive — never read during execution
mkdir -p "$TASKS_DIR"/archive/{done,reviews,solutions}

# Active sprint state (only in-flight tasks)
cat > "$TASKS_DIR/active/progress.json" << 'EOF'
{
  "version": 1,
  "sprint": null,
  "tasks": {},
  "counters": {
    "ideas": 0,
    "tasks": 0,
    "solutions": 0
  }
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
