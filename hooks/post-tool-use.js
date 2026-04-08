#!/usr/bin/env node

// SoloFlow post-tool-use hook — auto-lint after Write/Edit
// Non-blocking advisory: always exits 0, injects warnings via additionalContext

const path = require('path');
const { execSync } = require('child_process');
const { detectLinter } = require(path.join(__dirname, 'detect-tools'));

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const cwd = event.cwd || process.cwd();
    const filePath = event.tool_input && event.tool_input.file_path;

    if (!filePath) {
      process.exit(0);
    }

    const linter = detectLinter(cwd, filePath);
    if (!linter) {
      process.exit(0);
    }

    try {
      execSync(linter.command, { cwd, timeout: 10000, stdio: 'pipe' });
      // Linter passed — no output needed
    } catch (lintError) {
      const output = (lintError.stdout || '').toString().trim();
      const stderr = (lintError.stderr || '').toString().trim();
      const message = output || stderr || 'Linter reported errors';

      // Truncate to avoid overwhelming context
      const truncated = message.length > 500
        ? message.substring(0, 500) + '\n... (truncated)'
        : message;

      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `Lint warning for ${path.basename(filePath)}:\n${truncated}`
        }
      }));
    }
  } catch (e) {
    // Ignore JSON parse errors or unexpected failures — never block
  }

  process.exit(0);
});
