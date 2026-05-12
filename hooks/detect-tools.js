#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Match end-to-end test runners. These almost always need a browser binary, a
// built artifact, or a GUI session before they can even initialize, so running
// them as part of an unattended quality gate produces noise instead of signal.
const E2E_PATTERN = /\b(playwright|cypress|webdriverio|webdriver|detox|maestro|nightwatch)\b/i;

/**
 * Detect the project's test runner from config files.
 * Returns { command, kind, runnable } or null.
 *   command:  the shell command to execute.
 *   kind:     'unit' | 'e2e' — best-effort classification.
 *   runnable: whether the runner's deps appear installed in the current cwd
 *             (e.g., node_modules present for npm test, pytest on PATH).
 */
function detectTestRunner(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const testScript = pkg.scripts && pkg.scripts.test;
      if (testScript && !testScript.includes('echo "Error')) {
        const kind = E2E_PATTERN.test(testScript) ? 'e2e' : 'unit';
        const runnable = fs.existsSync(path.join(cwd, 'node_modules'));
        return { command: 'npm test', kind, runnable };
      }
    } catch (e) { /* ignore parse errors */ }
  }

  if (fs.existsSync(path.join(cwd, 'pytest.ini'))) {
    return { command: 'pytest', kind: 'unit', runnable: hasBinary('pytest') };
  }
  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    try {
      const content = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8');
      if (content.includes('[tool.pytest')) {
        return { command: 'pytest', kind: 'unit', runnable: hasBinary('pytest') };
      }
    } catch (e) { /* ignore */ }
  }

  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { command: 'cargo test', kind: 'unit', runnable: hasBinary('cargo') };
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { command: 'go test ./...', kind: 'unit', runnable: hasBinary('go') };
  }

  return null;
}

function hasBinary(name) {
  const { execSync } = require('child_process');
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Detect the project's type checker from config files.
 * Returns { command, runnable } or null.
 *   runnable: whether the checker's binary/deps are present locally so we
 *             don't trigger an `npx` download mid-hook or fail on a missing
 *             mypy install.
 */
function detectTypeChecker(cwd) {
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    const localTsc = fs.existsSync(path.join(cwd, 'node_modules', 'typescript', 'package.json'))
      || fs.existsSync(path.join(cwd, 'node_modules', '.bin', 'tsc'));
    return { command: 'npx tsc --noEmit', runnable: localTsc };
  }

  const pyproject = path.join(cwd, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    try {
      const content = fs.readFileSync(pyproject, 'utf8');
      if (content.includes('[tool.mypy')) {
        return { command: 'mypy .', runnable: hasBinary('mypy') };
      }
    } catch (e) { /* ignore */ }
  }

  if (fs.existsSync(path.join(cwd, 'mypy.ini'))) {
    return { command: 'mypy .', runnable: hasBinary('mypy') };
  }

  return null;
}

/**
 * Detect a linter for the given file based on its extension.
 * Returns { command: string } or null.
 */
function detectLinter(cwd, filePath) {
  if (!filePath) return null;

  const ext = path.extname(filePath).toLowerCase();
  const jsExts = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.mts'];
  const pyExts = ['.py'];

  if (jsExts.includes(ext)) {
    const eslintConfigs = [
      '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml',
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'
    ];
    for (const config of eslintConfigs) {
      if (fs.existsSync(path.join(cwd, config))) {
        return { command: `npx eslint "${filePath}"` };
      }
    }
    // Check package.json for eslintConfig
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.eslintConfig) return { command: `npx eslint "${filePath}"` };
      } catch (e) { /* ignore */ }
    }
  }

  if (pyExts.includes(ext)) {
    const pyproject = path.join(cwd, 'pyproject.toml');
    if (fs.existsSync(pyproject)) {
      try {
        const content = fs.readFileSync(pyproject, 'utf8');
        if (content.includes('[tool.ruff')) return { command: `ruff check "${filePath}"` };
      } catch (e) { /* ignore */ }
    }
    if (fs.existsSync(path.join(cwd, '.flake8'))) {
      return { command: `flake8 "${filePath}"` };
    }
  }

  return null;
}

module.exports = { detectTestRunner, detectTypeChecker, detectLinter };
