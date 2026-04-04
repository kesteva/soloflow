#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Detect the project's test runner from config files.
 * Returns { command: string } or null.
 */
function detectTestRunner(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const testScript = pkg.scripts && pkg.scripts.test;
      if (testScript && !testScript.includes('echo "Error')) {
        return { command: 'npm test' };
      }
    } catch (e) { /* ignore parse errors */ }
  }

  if (fs.existsSync(path.join(cwd, 'pytest.ini'))) return { command: 'pytest' };
  if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    try {
      const content = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8');
      if (content.includes('[tool.pytest')) return { command: 'pytest' };
    } catch (e) { /* ignore */ }
  }

  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return { command: 'cargo test' };
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return { command: 'go test ./...' };

  return null;
}

/**
 * Detect the project's type checker from config files.
 * Returns { command: string } or null.
 */
function detectTypeChecker(cwd) {
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    return { command: 'npx tsc --noEmit' };
  }

  const pyproject = path.join(cwd, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    try {
      const content = fs.readFileSync(pyproject, 'utf8');
      if (content.includes('[tool.mypy')) return { command: 'mypy .' };
    } catch (e) { /* ignore */ }
  }

  if (fs.existsSync(path.join(cwd, 'mypy.ini'))) return { command: 'mypy .' };

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
