#!/usr/bin/env bash
set -euo pipefail

# SoloFlow updater (script fallback) — updates a project that was installed
# with scripts/install.sh to a newer version. Never touches `.soloflow/`.
#
# The primary update path is `/plugin update soloflow` inside Claude Code.
# This script is only for projects vendored via scripts/install.sh.
#
# How it works:
#   1. Reads the currently-installed version from .claude/soloflow-install/VERSION.
#   2. Reads the new version from the source's plugin.json.
#   3. Snapshots the old install manifest.
#   4. Re-runs install.sh (idempotent: overwrites files it owns, re-registers hooks).
#   5. Prunes files that were in the old manifest but not the new one (moved,
#      renamed, or removed upstream).
#
# Usage: bash update.sh [project_dir]
# Defaults to current directory if no argument given.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOLOFLOW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "${1:-.}" && pwd)"

RUNTIME_DIR="$PROJECT_DIR/.claude/soloflow-install"
OLD_VERSION_FILE="$RUNTIME_DIR/VERSION"
OLD_MANIFEST="$RUNTIME_DIR/manifest.json"

if [ ! -f "$OLD_VERSION_FILE" ] || [ ! -f "$OLD_MANIFEST" ]; then
  echo "  [error] no script install detected at $PROJECT_DIR" >&2
  echo "          (missing $RUNTIME_DIR/{VERSION,manifest.json})" >&2
  echo "          If you installed via the Claude Code plugin system, run" >&2
  echo "          '/plugin update soloflow' inside Claude Code instead." >&2
  exit 1
fi

OLD_VERSION="$(cat "$OLD_VERSION_FILE")"
NEW_VERSION="$(node -e "console.log(require('$SOLOFLOW_DIR/.claude-plugin/plugin.json').version)")"

echo "Updating SoloFlow"
echo "  Project: $PROJECT_DIR"
echo "  $OLD_VERSION -> $NEW_VERSION"
echo ""

if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "  Already at v$NEW_VERSION. Re-running install to refresh files."
  echo ""
fi

# Snapshot the old manifest so we can diff after install.sh rewrites it.
OLD_MANIFEST_SNAPSHOT="$(mktemp)"
cp "$OLD_MANIFEST" "$OLD_MANIFEST_SNAPSHOT"
trap 'rm -f "$OLD_MANIFEST_SNAPSHOT"' EXIT

# Re-run install. It is idempotent, handles copies + hook re-registration,
# and leaves .soloflow/ alone.
bash "$SOLOFLOW_DIR/scripts/install.sh" "$PROJECT_DIR"

# Prune files that were in the old manifest but are not in the new one.
echo ""
node <<NODE
const fs = require('fs');
const path = require('path');

const oldManifest = JSON.parse(fs.readFileSync('$OLD_MANIFEST_SNAPSHOT', 'utf8'));
const newManifest = JSON.parse(fs.readFileSync('$OLD_MANIFEST', 'utf8'));

const newSet = new Set(newManifest.files);
const removed = oldManifest.files.filter((f) => !newSet.has(f));

if (removed.length === 0) {
  console.log('  [prune] nothing to remove');
} else {
  for (const rel of removed) {
    const abs = path.join('$PROJECT_DIR', rel);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      console.log('  [prune] ' + rel);
    }
  }
  // Drop any now-empty directories we may have left behind.
  const dirs = new Set(removed.map((r) => path.dirname(path.join('$PROJECT_DIR', r))));
  for (const d of dirs) {
    try {
      if (fs.readdirSync(d).length === 0) {
        fs.rmdirSync(d);
        console.log('  [prune] ' + path.relative('$PROJECT_DIR', d) + '/ (empty)');
      }
    } catch (e) { /* ignore */ }
  }
}
NODE

echo ""
echo "Update complete. \`.soloflow/\` state was not touched."
