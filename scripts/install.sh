#!/usr/bin/env bash
set -euo pipefail

# SoloFlow installer — symlinks agents, commands, and registers hooks in a target project.
# Usage: bash install.sh [project_dir]
# Defaults to current directory if no argument given.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOLOFLOW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "${1:-.}" && pwd)"

echo "Installing SoloFlow into $PROJECT_DIR"
echo "  Source: $SOLOFLOW_DIR"
echo ""

# --- Symlink agents ---
mkdir -p "$PROJECT_DIR/.claude/agents"
for agent in "$SOLOFLOW_DIR"/agents/soloflow-*.md; do
  name="$(basename "$agent")"
  target="$PROJECT_DIR/.claude/agents/$name"
  if [ -L "$target" ] || [ -e "$target" ]; then
    echo "  [skip] agents/$name (already exists)"
  else
    ln -s "$agent" "$target"
    echo "  [link] agents/$name"
  fi
done

# --- Symlink commands ---
mkdir -p "$PROJECT_DIR/.claude/commands/soloflow"
for cmd in "$SOLOFLOW_DIR"/commands/soloflow-*.md; do
  name="$(basename "$cmd")"
  target="$PROJECT_DIR/.claude/commands/soloflow/$name"
  if [ -L "$target" ] || [ -e "$target" ]; then
    echo "  [skip] commands/soloflow/$name (already exists)"
  else
    ln -s "$cmd" "$target"
    echo "  [link] commands/soloflow/$name"
  fi
done

# --- Register hooks in .claude/settings.json ---
SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"

# Build the hooks JSON using node (available if Claude Code is installed)
node -e "
const fs = require('fs');
const path = require('path');

const settingsFile = '$SETTINGS_FILE';
const soloflowDir = '$SOLOFLOW_DIR';

// Load existing settings or create new
let settings = {};
if (fs.existsSync(settingsFile)) {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
}

if (!settings.hooks) settings.hooks = {};

const hookDefs = [
  {
    event: 'SessionStart',
    file: 'soloflow-session-start.js',
    timeout: 10
  },
  {
    event: 'PostToolUse',
    file: 'soloflow-post-tool-use.js',
    timeout: 15,
    matcher: 'Write|Edit'
  },
  {
    event: 'TaskCompleted',
    file: 'soloflow-task-completed.js',
    timeout: 120
  },
  {
    event: 'PreCompact',
    file: 'soloflow-pre-compact.js',
    timeout: 10
  },
  {
    event: 'SubagentStop',
    file: 'soloflow-subagent-stop.js',
    timeout: 10
  }
];

for (const def of hookDefs) {
  const command = 'node \"' + path.join(soloflowDir, 'hooks', def.file) + '\"';

  // Check if this hook is already registered
  if (!settings.hooks[def.event]) settings.hooks[def.event] = [];
  const existing = settings.hooks[def.event];
  const alreadyRegistered = existing.some(group =>
    group.hooks && group.hooks.some(h => h.command && h.command.includes(def.file))
  );

  if (!alreadyRegistered) {
    const entry = {
      hooks: [{
        type: 'command',
        command: command,
        timeout: def.timeout
      }]
    };
    if (def.matcher) entry.matcher = def.matcher;
    existing.push(entry);
    console.log('  [hook] ' + def.event + ' -> ' + def.file);
  } else {
    console.log('  [skip] ' + def.event + ' (already registered)');
  }
}

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
"

# --- Initialize state directory ---
echo ""
bash "$SOLOFLOW_DIR/scripts/init.sh" "$PROJECT_DIR/.soloflow"

echo ""
echo "Done. Start a Claude Code session and try:"
echo "  /soloflow-status"
echo "  /soloflow-quick \"fix a bug\""
echo "  /soloflow-idea-extractor \"add a new feature\""
echo "  /soloflow-planner IDEA-001"
echo "  /soloflow-executor"
echo "  /soloflow-compound"
