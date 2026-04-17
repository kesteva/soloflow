# Changelog

All notable changes to SoloFlow are documented in this file.

## [0.8.1] - 2026-04-17

### Changed
- **Verifier auto-resolves AC-prescribed scope deviations.** `agents/verifier.md` Plan-Prescribed Scope Deviations section now resolves a `scope_deviation` finding on either (a) the plan text naming the file, or (b) the change being required by a broad AC such as "all suites must pass." Previously only (a) triggered auto-resolve, producing recurring open findings whenever enabling a feature broke an outside-of-`files_owned` test.
- **Sprint-verifier now emits per-platform outcomes.** `agents/sprint-verifier.md` splits its single Visual Verification status into `visual_mobile` and `visual_web` (same 5-value enum as the per-task verifier) and persists them to `.soloflow/active/sprint-verification.md`, archived at sprint close to `.soloflow/archive/sprint-verifications/SPRINT-NNN-verification.md`.

### Added
- **Done-report schema gains `executor_loops` and `code_review_rounds`.** `commands/executor.md` step f3 defines the canonical done-report frontmatter; orchestrators (`executor`, `mad-max`, `quick`) track both counters per task and write them into the report. Sprint-closer sums them into `total_executor_loops` / `total_code_review_rounds`; compounder uses them as evidence for D-bucket recommendations (e.g. "shared-helper integration tasks consistently need two code-review rounds").
- **Visual verification five-bucket classification.** Per-task verifier and sprint-verifier emit `pass | fail | not_applicable | skipped_user_preference | skipped_unable` for each platform, surfaced at sprint end by `/soloflow:executor` Step 5 and `/soloflow:mad-max` final report. Distinguishes healthy skips (user preference, N/A) from coverage gaps (unable to run).

## [0.8.0] - 2026-04-15

### Added
- **`/soloflow:mad-max`** — unattended backlog-drain command. Runs the full per-task quality loop (executor → verifier → code-reviewer → test-writer) against every ready task, plus the end-of-sprint regression check, with zero interactive prompts during the run. Hardcodes `create_branch: true` and `merge_choice: keep_open`; stuck / human-needed tasks are logged and skipped. Hard-stops only on conditions mad-max cannot safely bypass (active sprint, dirty worktree, blocking deferred items, red smoke baseline). Use this when you want to kick off a run and walk away.

## [0.5.2] - 2026-04-09

### Fixed
- **Plugin install actually works now.** Added `.claude-plugin/marketplace.json` so the repo declares itself as a Claude Code plugin marketplace. Previously `/plugin install soloflow` and `claude plugin install https://github.com/kesteva/soloflow` both failed with "not found in any configured marketplace" because neither command accepts a bare GitHub URL.
- **README install instructions corrected.** The real flow is two steps: `/plugin marketplace add kesteva/soloflow` then `/plugin install soloflow@soloflow`. Updates use `/plugin update soloflow@soloflow`.

## [0.5.1] - 2026-04-09

### Changed
- **`/soloflow:init` is now idempotent.** Re-running on an already-initialized project no longer exits early — it creates any missing directories or state files (handy when upgrading across a release that adds new state artifacts) and leaves existing files untouched. `scripts/init.sh` mirrors the same repair behavior for the shell fallback.
- **`/soloflow:init` now includes a setup wizard.** After scaffolding, it asks about visual verification (Q1 on/off → Q2 project type → dependency check with optional Maestro installer) and the branch strategy for `/soloflow:executor` runs, then writes `.soloflow/config.json`. Re-running surfaces current values as `(current)` so you can keep or change them.
- **Verifier visual toggles are now overrideable per-project.** `agents/verifier.md` resolves `verification.visual_mobile` / `verification.visual_web` via `.soloflow/config.json` → `config/defaults.yaml` → `false` fallback. The wizard's answers take effect immediately.

### Added
- Orphaned-file detection in `/soloflow:init`: surfaces pre-0.5.0 `.soloflow/counters.json` in the post-init report without deleting it.

## [0.5.0] - 2026-04-09

### Removed (BREAKING)
- **`counters.json`** — deleted. Parallel workers racing on a shared mutable counter caused merge conflicts without adding value. ID allocation (`IDEA-NNN`, `TASK-NNN`, `SPRINT-NNN`, `SOL-NNN`) is now derived from the filesystem: glob the artifact locations, take `max(numeric_suffix) + 1`. Writes use `noclobber` / `wx` semantics and retry on collision. See the "ID allocation" section in `CLAUDE.md` for the shared recipe.

### Changed
- `scripts/init.sh` and `/soloflow:init` no longer create `counters.json`.
- All phase commands (`idea-extractor`, `planner`, `executor`, `quick`, `compound`) compute next IDs by globbing instead of reading/writing a counter file.
- `commands/executor.md` now writes `sprint.id` into `sprint.json` directly (previously derived from the sprints counter).

### Migration from 0.4.x
Delete `.soloflow/counters.json` from your project — it's no longer read or written. Everything else keeps working; existing ID sequences are preserved because the filesystem already reflects the highest allocated ID.

## [0.4.0] - 2026-04-09

### Added
- **Findings queue** — `.soloflow/active/findings.md`. Executor, verifier, and code-reviewer append out-of-scope observations here instead of expanding scope or dropping them. Consumed and archived by the compounder.
- **Interactive four-bucket compounder** — `/soloflow:compound` now produces `COMPOUND-PROPOSAL.md` with (A) clean-ups applied inline, (B) backlog ideas queued as `IDEA-NNN.md`, (C) CLAUDE.md improvements applied directly, (D) reusable patterns archived as SOL files under `archive/solutions/SPRINT-NNN/`. The user approves per-bucket; the main agent applies approved items with atomic commits. Rejected items are preserved in `archive/compound/`.
- **Run branches for `/soloflow:executor`** — new `git.branch_per_run` config (`always` / `never` / `prompt`, default `prompt`) creates a dedicated branch per execution run, merged back with `--no-ff` after human review. Overrideable per-project via `.soloflow/config.json`. `sprint.json` gains a `run` object so resume detects the branch across sessions.

### Changed
- **Executor commit discipline** — `agents/executor.md` now treats atomic commits as mandatory, not advisory. Commits must be reported in the `COMPLETED` status report.
- **`config/defaults.yaml`** — gains a `git:` block. Most values remain non-runtime-read; `git.branch_per_run` IS runtime-read (exception documented in `docs/CUSTOMIZATION.md`).

## [0.3.0] - 2026-04-08

### Added
- `/soloflow:init` — new command that explicitly scaffolds `.soloflow/` in the current project. Required once per project before any other phase command will run.
- All seven phase commands (`idea-extractor`, `planner`, `executor`, `compound`, `quick`, `status`, `verify`) gate on `.soloflow/` existence and refuse to run if missing, pointing the user at `/soloflow:init`.

### Changed
- Replaced the 0.2.0 SessionStart auto-init with a user-visible prompt. When `.soloflow/` is missing, the hook tells the user to run `/soloflow:init` instead of silently creating files. `SOLOFLOW_AUTOINIT` env var removed.

## [0.2.0] - 2026-04-08

### Changed (BREAKING)
- All agent, command, hook, and skill files renamed to drop the `soloflow-` prefix. The `soloflow` plugin namespace is applied at invocation time instead.
- Slash commands moved from `/soloflow-<name>` to `/soloflow:<name>` (e.g. `/soloflow-planner` → `/soloflow:planner`). Existing projects must reinstall.
- `scripts/install.sh` rewritten as a copy-based installer (no more symlinks). Works on Windows without Developer Mode, survives source-clone relocation, supports per-project version pinning.

### Added
- `/plugin install soloflow` is now the primary install path. The repo ships as a valid Claude Code plugin with auto-discovery of agents/commands/hooks/skills.
- `scripts/update.sh` — manifest-diff updater for the script-install fallback. Copies new files, prunes removed ones, leaves `.soloflow/` untouched.
- `.claude/soloflow-install/manifest.json` and `VERSION` stamp track the installed file set for idempotent reinstall/update/uninstall.
- `docs/PLUGIN-MIGRATION-PLAN.md` documents the migration from symlink install to plugin distribution.

### Migration from 0.1.0
1. Uninstall the old scaffolding: `bash <path-to-soloflow>/scripts/uninstall.sh --scaffolding` (preserves `.soloflow/`).
2. Install the plugin: `/plugin install soloflow` (or re-run the new `scripts/install.sh` for the vendored path).
3. Update any scripts or docs referencing `/soloflow-<name>` to `/soloflow:<name>`.

## [0.1.0] - 2026-04-04

### Added
- Five-phase workflow: idea extraction, task refinement, execution sprint, human review, compound learning
- 7 agent definitions: executor, verifier, code-reviewer, idea-extractor, researcher, task-refiner, compounder
- 5 hooks: session-start, post-tool-use, task-completed, pre-compact, subagent-stop
- 7 commands: `/soloflow-idea-extractor`, `/soloflow-planner`, `/soloflow-executor`, `/soloflow-compound`, `/soloflow-quick`, `/soloflow-status`, `/soloflow-verify`
- Visual verification skill with Maestro MCP (mobile) and Playwright MCP (web)
- State management with active/archive split in `.soloflow/`
- Install script for per-project setup
- Default configuration in `config/defaults.yaml`
- Documentation: architecture, customization, contributing, visual verification setup
