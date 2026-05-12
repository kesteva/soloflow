#!/usr/bin/env node

// SoloFlow task-completed hook — quality gate
// Blocks task completion (exit 2) if test suite or type checker fails.
//
// Reads `quality_gate.*` from .soloflow/config.json + config/defaults.yaml so
// projects can opt out of pieces of the gate, and skips runs that obviously
// can't succeed (E2E runners, missing deps) rather than producing false
// failures on setup tasks. See config/defaults.yaml for the knobs.

const path = require('path');
const { execSync } = require('child_process');
const { detectTestRunner, detectTypeChecker } = require(path.join(__dirname, 'detect-tools'));

function loadConfig() {
  try {
    return require(path.join(__dirname, '..', 'scripts', 'lib', 'config'));
  } catch (e) {
    return null;
  }
}

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const cwd = event.cwd || process.cwd();
    const config = loadConfig();
    const resolve = (key, fallback) =>
      config ? config.resolve(key, fallback, cwd) : fallback;

    const gateEnabled = resolve('quality_gate.enabled', true);
    if (!gateEnabled) process.exit(0);

    const runTest = resolve('quality_gate.test', true);
    const runTypecheck = resolve('quality_gate.typecheck', true);
    const skipE2E = resolve('quality_gate.skip_e2e', true);
    const skipUnrunnable = resolve('quality_gate.skip_when_unrunnable', true);

    const failures = [];
    const notes = [];

    if (runTest) {
      const testRunner = detectTestRunner(cwd);
      if (testRunner) {
        if (skipE2E && testRunner.kind === 'e2e') {
          notes.push(`skipped E2E test runner (${testRunner.command}); set quality_gate.skip_e2e=false to enable`);
        } else if (skipUnrunnable && testRunner.runnable === false) {
          notes.push(`skipped tests — runner deps not installed for ${testRunner.command}`);
        } else {
          try {
            execSync(testRunner.command, { cwd, timeout: 90000, stdio: 'pipe' });
          } catch (e) {
            const output = (e.stdout || '').toString().trim();
            const stderr = (e.stderr || '').toString().trim();
            failures.push(`Test suite failed:\n${output || stderr || 'Unknown error'}`);
          }
        }
      }
    }

    if (runTypecheck) {
      const typeChecker = detectTypeChecker(cwd);
      if (typeChecker) {
        if (skipUnrunnable && typeChecker.runnable === false) {
          notes.push(`skipped typecheck — ${typeChecker.command} not installed locally`);
        } else {
          try {
            execSync(typeChecker.command, { cwd, timeout: 60000, stdio: 'pipe' });
          } catch (e) {
            const output = (e.stdout || '').toString().trim();
            const stderr = (e.stderr || '').toString().trim();
            failures.push(`Type checker failed:\n${output || stderr || 'Unknown error'}`);
          }
        }
      }
    }

    if (failures.length > 0) {
      const message = failures.join('\n\n');
      const truncated = message.length > 1000
        ? message.substring(0, 1000) + '\n... (truncated)'
        : message;

      process.stderr.write(`SoloFlow quality gate failed:\n\n${truncated}\n`);
      process.exit(2);
    }

    if (notes.length > 0) {
      // Non-blocking informational notes — go to stderr so they surface in
      // logs without affecting the exit code.
      process.stderr.write(`SoloFlow quality gate: ${notes.join('; ')}\n`);
    }
    process.exit(0);
  } catch (e) {
    // JSON parse error or unexpected failure — don't block.
    process.exit(0);
  }
});
