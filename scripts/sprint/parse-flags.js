#!/usr/bin/env node
'use strict';

// Parse orchestrator flags into structured JSON.
//
// Recognized flags (all scopes):
//   --quick               shorthand for --no-code-review --no-verification
//   --no-code-review      disables per-task + end-of-sprint code review
//   --no-verification     disables per-task + end-of-sprint verification
//
// Unknown --flags → exit 2 with an error JSON on stdout (orchestrator prints it).
// Positional args (TASK-NNN, IDEA-NNN, or arbitrary strings) pass through.
//
// Usage:
//   node parse-flags.js --args "$ARGUMENTS"
//   node parse-flags.js -- "$@"
//
// Output (JSON on stdout):
//   {
//     "positional": ["TASK-001", "IDEA-004", ...],
//     "flags": { quick, no_code_review, no_verification },
//     "effective": {
//        per_task_verification_enabled,
//        per_task_code_review_enabled,
//        sprint_verification_enabled,
//        sprint_code_review_enabled
//     },
//     "summary_line": "Flags active: ...",   // empty string if nothing disabled
//     "error": "Unknown flag: --foo. ..."    // present only on error; exit 2
//   }

const config = require('../lib/config');

const RECOGNIZED = new Set(['--quick', '--no-code-review', '--no-verification']);

function tokenize(argv) {
  // Preferred: --args "<string>" (single arg with whitespace). Fallback: plain argv.
  const idx = argv.indexOf('--args');
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    const s = argv[idx + 1].trim();
    if (s === '') return [];
    return s.split(/\s+/);
  }
  // Strip a leading literal `--` separator if present.
  const trimmed = argv[0] === '--' ? argv.slice(1) : argv;
  return trimmed.filter((t) => t !== '');
}

function main() {
  const tokens = tokenize(process.argv.slice(2));
  const flags = { quick: false, no_code_review: false, no_verification: false };
  const positional = [];
  for (const t of tokens) {
    if (t.startsWith('--')) {
      if (!RECOGNIZED.has(t)) {
        process.stdout.write(JSON.stringify({
          error: `Unknown flag: ${t}. Recognized flags: --quick, --no-code-review, --no-verification.`,
        }) + '\n');
        process.exit(2);
      }
      if (t === '--quick') flags.quick = true;
      else if (t === '--no-code-review') flags.no_code_review = true;
      else if (t === '--no-verification') flags.no_verification = true;
    } else {
      positional.push(t);
    }
  }

  const codeReviewCfg = config.resolve('code_review.enabled', true);
  const sprintCodeReviewCfg = config.resolve('sprint_code_review.enabled', true);

  const per_task_verification_enabled = !(flags.no_verification || flags.quick);
  const per_task_code_review_enabled = Boolean(codeReviewCfg) && !(flags.no_code_review || flags.quick);
  const sprint_verification_enabled = !(flags.no_verification || flags.quick);
  const sprint_code_review_enabled = Boolean(sprintCodeReviewCfg) && !(flags.no_code_review || flags.quick);

  const disabled = [];
  if (!per_task_verification_enabled) disabled.push('per-task verification disabled');
  if (!sprint_verification_enabled) disabled.push('end-of-sprint verification disabled');
  if (!per_task_code_review_enabled) disabled.push('per-task code review disabled');
  if (!sprint_code_review_enabled) disabled.push('end-of-sprint code review disabled');

  const summary_line = disabled.length ? 'Flags active: ' + disabled.join(', ') + '.' : '';

  process.stdout.write(JSON.stringify({
    positional,
    flags,
    effective: {
      per_task_verification_enabled,
      per_task_code_review_enabled,
      sprint_verification_enabled,
      sprint_code_review_enabled,
    },
    summary_line,
  }, null, 2) + '\n');
}

main();
