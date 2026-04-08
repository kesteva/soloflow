#!/usr/bin/env node

// SoloFlow task-completed hook — quality gate
// Blocks task completion (exit 2) if test suite or type checker fails

const path = require('path');
const { execSync } = require('child_process');
const { detectTestRunner, detectTypeChecker } = require(path.join(__dirname, 'detect-tools'));

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const cwd = event.cwd || process.cwd();
    const failures = [];

    // Run test suite
    const testRunner = detectTestRunner(cwd);
    if (testRunner) {
      try {
        execSync(testRunner.command, { cwd, timeout: 90000, stdio: 'pipe' });
      } catch (e) {
        const output = (e.stdout || '').toString().trim();
        const stderr = (e.stderr || '').toString().trim();
        failures.push(`Test suite failed:\n${output || stderr || 'Unknown error'}`);
      }
    }

    // Run type checker
    const typeChecker = detectTypeChecker(cwd);
    if (typeChecker) {
      try {
        execSync(typeChecker.command, { cwd, timeout: 60000, stdio: 'pipe' });
      } catch (e) {
        const output = (e.stdout || '').toString().trim();
        const stderr = (e.stderr || '').toString().trim();
        failures.push(`Type checker failed:\n${output || stderr || 'Unknown error'}`);
      }
    }

    if (failures.length > 0) {
      // Truncate combined output to keep stderr manageable
      const message = failures.join('\n\n');
      const truncated = message.length > 1000
        ? message.substring(0, 1000) + '\n... (truncated)'
        : message;

      process.stderr.write(`SoloFlow quality gate failed:\n\n${truncated}\n`);
      process.exit(2);
    }

    // All checks passed (or no tools detected)
    process.exit(0);
  } catch (e) {
    // JSON parse error or unexpected failure — don't block
    process.exit(0);
  }
});
