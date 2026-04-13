#!/usr/bin/env node

// SoloFlow Statusline — displays sprint/task status + context usage bar
// Also writes context metrics to a bridge file for the context-monitor hook.
//
// Claude Code calls this to render the status bar. It receives JSON via stdin
// containing model info, session_id, context_window metrics, and workspace.

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- SoloFlow state reader --------------------------------------------------

function readSoloFlowState(dir) {
  const soloflowDir = path.join(dir, '.soloflow');
  if (!fs.existsSync(soloflowDir)) return null;

  const state = {};

  // Read sprint.json
  const sprintPath = path.join(soloflowDir, 'active', 'sprint.json');
  if (fs.existsSync(sprintPath)) {
    try {
      const sprint = JSON.parse(fs.readFileSync(sprintPath, 'utf8'));
      if (sprint.sprint) {
        state.sprintId = sprint.sprint.id;
        state.sprintStatus = sprint.sprint.status;
      }
      const tasks = Object.entries(sprint.tasks || {});
      state.inProgress = tasks.filter(([, t]) => t.status === 'in_progress').map(([id]) => id);
      state.stuck = tasks.filter(([, t]) => t.status === 'stuck').length;
      state.humanNeeded = tasks.filter(([, t]) => t.status === 'human_needed').length;
    } catch (e) { /* ignore parse errors */ }
  }

  // Read backlog.json for ready count
  const backlogPath = path.join(soloflowDir, 'active', 'backlog.json');
  if (fs.existsSync(backlogPath)) {
    try {
      const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
      state.ready = Object.values(backlog.tasks || {}).filter(t => t.status === 'ready').length;
    } catch (e) { /* ignore */ }
  }

  return state;
}

function formatState(s) {
  if (!s) return '';
  const parts = [];

  if (s.sprintId) {
    parts.push(`${s.sprintId} (${s.sprintStatus || 'unknown'})`);
  }

  if (s.inProgress && s.inProgress.length > 0) {
    parts.push(s.inProgress.join(', '));
  }

  const counts = [];
  if (s.ready) counts.push(`${s.ready} ready`);
  if (s.stuck) counts.push(`${s.stuck} stuck`);
  if (s.humanNeeded) counts.push(`${s.humanNeeded} human`);
  if (counts.length > 0) parts.push(counts.join(', '));

  return parts.join(' · ');
}

// --- stdin ------------------------------------------------------------------

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const model = data.model?.display_name || 'Claude';
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Context window display — normalize to usable context
    // Claude Code reserves ~16.5% for autocompact buffer
    const AUTO_COMPACT_BUFFER_PCT = 16.5;
    let ctx = '';
    if (remaining != null) {
      const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Write bridge file for context-monitor hook
      const sessionSafe = session && !/[/\\]|\.\./.test(session);
      if (sessionSafe) {
        try {
          const bridgePath = path.join(os.tmpdir(), `soloflow-ctx-${session}.json`);
          fs.writeFileSync(bridgePath, JSON.stringify({
            session_id: session,
            remaining_percentage: remaining,
            used_pct: used,
            timestamp: Math.floor(Date.now() / 1000)
          }));
        } catch (e) { /* bridge is best-effort */ }
      }

      // Build progress bar (10 segments)
      const filled = Math.floor(used / 10);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);

      if (used < 50) {
        ctx = ` \x1b[32m${bar} ${used}%\x1b[0m`;
      } else if (used < 65) {
        ctx = ` \x1b[33m${bar} ${used}%\x1b[0m`;
      } else if (used < 80) {
        ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m`;
      } else {
        ctx = ` \x1b[5;31m\u{1F480} ${bar} ${used}%\x1b[0m`;
      }
    }

    // SoloFlow state
    const sfState = formatState(readSoloFlowState(dir));
    const dirname = path.basename(dir);

    if (sfState) {
      process.stdout.write(`\x1b[2m${model}\x1b[0m \u2502 \x1b[2m${sfState}\x1b[0m \u2502 \x1b[2m${dirname}\x1b[0m${ctx}`);
    } else {
      process.stdout.write(`\x1b[2m${model}\x1b[0m \u2502 \x1b[2m${dirname}\x1b[0m${ctx}`);
    }
  } catch (e) {
    // Silent fail — never break statusline
  }
});
