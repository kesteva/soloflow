---
description: Deep-clean the codebase — remove dead code, trim CLAUDE.md files, and verify no regressions
argument-hint: "[optional: scope path to focus on]"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:prune

Performs a comprehensive pruning pass across the codebase and all CLAUDE.md files. Spins up parallel analysis agents, presents findings for approval, applies approved changes, and runs the test suite to confirm no regressions.

Scope: **$ARGUMENTS** (optional — limit analysis to a specific directory; defaults to entire project)

---

## Model resolution

Run once:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/config/resolve.js" \
    --key models.codebase_pruner --key models.claudemd_pruner \
    --fallback opus --fallback opus
```

Line 1 is the codebase-pruner model; line 2 is the claudemd-pruner model.

## Step 0: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Create prune branch

1. Verify working tree is clean: `git status --porcelain`. If dirty, tell the user to commit or stash first and stop.
2. Capture current branch: `git rev-parse --abbrev-ref HEAD`.
3. Create and checkout a new branch: `git checkout -b soloflow/prune-$(date +%Y%m%d-%H%M%S)`.
4. Print: `Prune branch: {branch_name} (base: {base_branch})`.

## Step 2: Parallel analysis

Spawn **two agents in parallel** using the Agent tool:

### Agent A: Codebase Pruner
- Agent definition: `codebase-pruner`
- Task: "Audit the codebase at `{project_root}` for dead code, redundancy, inefficiency, and orphaned assets. {If $ARGUMENTS specifies a scope, add: Focus on `{scope}`.} Produce a structured pruning report."
- Model: resolved `models.codebase_pruner` (see Model resolution above)

### Agent B: CLAUDE.md Pruner
- Agent definition: `claudemd-pruner`
- Task: "Audit all CLAUDE.md files in `{project_root}` for redundancy, staleness, scope misplacement, and content that should move to specialized reference files. Produce a structured pruning report."
- Model: resolved `models.claudemd_pruner` (see Model resolution above)

Wait for both agents to complete.

## Step 3: Present findings for approval

Combine the two reports into a unified presentation. For each category, present items grouped by type:

1. **Dead code & orphaned assets** (from Agent A)
2. **Redundancy & consolidation opportunities** (from Agent A)
3. **Inefficiencies** (from Agent A)
4. **CLAUDE.md changes** (from Agent B)

For each category that has items, use **AskUserQuestion** with options:
- **Approve all** — accept every item in this category
- **Approve some** — user specifies which items to keep (e.g., `D1, D3, R2`)
- **Reject all** — skip this category
- **Give feedback** — user provides notes; incorporate feedback and re-present this category

If a category is empty, skip it silently.

After all categories are reviewed, print a one-line summary of accepted/rejected counts.

## Step 4: Apply approved changes

Apply changes using atomic commits per the global atomic-commits rule.

### Dead code / orphaned assets
For each approved item:
1. Remove the dead file, dead export, or orphaned asset.
2. If removing an export, check if any re-exports or barrel files need updating.
3. Commit: `chore(prune): remove {description}`.

### Redundancy / consolidation
For each approved item:
1. Consolidate the duplicated code into the suggested target.
2. Update all former call sites to use the consolidated version.
3. Commit: `refactor(prune): consolidate {description}`.

### Inefficiencies
For each approved item:
1. Apply the suggested action (inline single-use abstraction, remove stale comment, etc.)
2. Commit: `refactor(prune): {description}`.

### CLAUDE.md changes
For each approved item:
1. If moving content to a new file (CODE-PATTERNS.md, etc.), create the target file first.
2. Apply the edit to the CLAUDE.md file (remove/tighten/move).
3. Add a one-line reference in CLAUDE.md if content was moved (not removed).
4. Commit: `docs(prune): {description}`.

If any edit fails to apply cleanly, log the error, skip that item, and continue.

## Step 5: Run test suite

Run the project's test suite to verify no regressions:

1. **Detect test runner:** check for common patterns in priority order:
   - `package.json` scripts: `test`, `test:unit`, `test:integration`
   - `Makefile` targets: `test`, `check`
   - Language-specific: `cargo test`, `go test ./...`, `pytest`, `mix test`
2. **Run unit tests** first. If they fail, stop and report which tests broke.
3. **Run integration tests** if available (look for `test:integration`, `test:e2e`, or similar). If they fail, report which tests broke.
4. **Run type checking** if applicable (`tsc --noEmit`, `mypy`, etc.)

### If tests fail:
1. Identify which commit(s) likely caused the failure based on the error.
2. Use **AskUserQuestion**: "Tests failed after pruning. Options:"
   - **Fix it** — attempt to fix the regression (then re-run tests)
   - **Revert the offending commit(s)** — `git revert {sha}` for the problematic change(s)
   - **Revert all and abort** — `git checkout {base_branch}` and delete the prune branch
3. If "Fix it" is chosen and the fix succeeds, commit: `fix(prune): resolve regression in {area}`.
4. Re-run the full suite after any fix or revert to confirm green.

### If tests pass:
Print: `All tests pass. Prune branch is ready for review.`

## Step 6: Report

Print a final summary:

```
Prune complete on branch: {branch_name}

Applied:
  Dead code removed    : {N} items ({lines} lines)
  Redundancy resolved  : {N} items
  Inefficiencies fixed : {N} items
  CLAUDE.md trimmed    : {N} edits across {M} files ({lines removed} lines saved)

New reference files created: {list or "none"}
Test suite: PASS
Commits: {count} ({commit range})

Next: review the branch, then merge when satisfied.
```

## Step 7: Merge prune branch

1. Use **AskUserQuestion** to ask: "Merge prune branch `<branch_name>` into `<base_branch>`?" with options:
   - **Merge locally** — merge with `--no-ff`, then delete the branch.
   - **Open PR** — push the branch and open a pull request on GitHub.
   - **Keep branch open** — stay on the prune branch for manual review/merge.
   - **Delete without merging** — discard all pruning (destructive).
2. On **Merge locally**:
   - `git checkout <base_branch>`
   - `git merge --no-ff <branch_name> -m "soloflow: merge prune <branch_name>"`
   - If the merge reports conflicts, leave markers in place, print the conflicting paths, and stop. Do not delete the branch.
   - On successful merge, delete the branch: `git branch -d <branch_name>`.
3. On **Open PR**:
   - `git push -u origin <branch_name>`
   - Create a PR with `gh pr create --base <base_branch> --head <branch_name>` using the prune report from Step 6 as the PR body.
   - Print the PR URL. Do not merge or delete — the user merges via GitHub.
4. On **Keep branch open**: stay on `<branch_name>`. Print the branch name + base so the user can merge manually later.
5. On **Delete without merging**: re-prompt with `AskUserQuestion` to confirm (destructive action). On confirmation, `git checkout <base_branch>` then `git branch -D <branch_name>`. On cancel, fall through to Keep branch open behavior.

---

## Notes

- This command creates a dedicated branch so all pruning changes are isolated and reviewable.
- After pruning, the user is prompted to merge locally, open a PR, keep the branch, or discard it.
- Both analysis agents are read-only; only the main agent (you) applies changes.
- Prefer conservative pruning — when in doubt about whether something is truly dead, ask the user rather than removing it.
- Do NOT prune `.soloflow/` state files, test fixtures that are dynamically loaded, or framework-specific magic files (e.g., `_app.tsx`, `+page.svelte`).
