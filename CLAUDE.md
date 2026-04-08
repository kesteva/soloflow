# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SoloFlow is a hooks-based Claude Code workflow orchestration system that automates the product development lifecycle: idea extraction → refinement → execution → verification → learning. Distributed as a Claude Code plugin (git repo + thin plugin wrapper) installable per-project or globally.

**First test case:** ImagiFable app (React Native/Expo).

## Architecture

Six-phase workflow orchestrated via Claude Code hooks and agent definitions:

1. **Idea Extraction** (Sonnet) — raw input → structured `.soloflow/active/ideas/IDEA-NNN.md`
2. **Research** (Sonnet, optional) — external ecosystem research → `.soloflow/active/research/IDEA-NNN-research.md`
3. **Task Refinement** (Opus) — idea + research → execution-ready `.soloflow/active/plans/TASK-NNN-plan.md`
4. **Execution Sprint** — Orchestrator (Opus) coordinates parallel Executor (Sonnet) + Verifier (Opus) + Code Reviewer (Opus) subagents via worktrees
5. **Human Review** — batched taste-level review (functional verification already done)
6. **Compound Learning** (Sonnet) — extract reusable patterns → `.soloflow/archive/solutions/SOL-NNN.md`

**Key constraint:** Subagents cannot spawn subagents. Orchestrator is main agent; executors/verifiers/reviewers are leaf nodes only.

### Components

- **`agents/`** — Agent definitions as markdown with YAML frontmatter
- **`hooks/`** — JavaScript Claude Code hooks, declared in `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` paths
- **`commands/`** — Slash command definitions, namespaced as `/soloflow:<name>`: `/soloflow:idea-extractor`, `/soloflow:planner`, `/soloflow:executor`, `/soloflow:compound`, `/soloflow:quick`, `/soloflow:status`, `/soloflow:verify`
- **`skills/`** — Skill definitions (e.g., `visual-verify/`)
- **`.mcp.json`** — MCP server declarations for Maestro and Playwright
- **`scripts/`** — Shell scripts (`init.sh`, `install.sh`, `uninstall.sh`)
- **`config/`** — `defaults.yaml` configuration

### State Layer

All workflow state lives in `.soloflow/` (created per-project by `scripts/init.sh`), split into active and archive:

**`.soloflow/active/`** — read during execution:
- `ideas/`, `research/`, `plans/`, `stuck/` — in-flight task files
- `backlog.json` — tasks awaiting execution (written by refinement, read by execution)
- `sprint.json` — active sprint + in-flight tasks (written/read by execution)

**`.soloflow/archive/`** — never read during execution:
- `done/`, `reviews/`, `solutions/` — completed task reports and learnings

**`.soloflow/`** root:
- `counters.json` — global ID counters (ideas, tasks, sprints, solutions)
- `checkpoint.md` — context restoration after compaction
- `human-review-queue.md` — batched items for human review

State is split into 3 JSON files (backlog, sprint, counters) to enable parallel worktree execution without merge conflicts. Completed tasks are removed from `sprint.json` and their reports move to `archive/done/`.

State format: Markdown with YAML frontmatter (optimized for LLM parsing + git diffs).

## Agent Model Strategy

- **Opus:** Orchestrator, Verifier, Task Refiner, Code Reviewer (quality-critical roles)
- **Sonnet:** Executor, Idea Extractor, Researcher, Compounder (cost optimization, ~60% reduction)

## Verification Layer

Multi-layered verification hierarchy (in order of authority):
1. Ground truth: test suite, type checker, linter
2. Visual: Maestro MCP (mobile), Playwright MCP (web)
3. Requirements adherence with concrete evidence
4. Goal-backward: "What must be TRUE for production?"
5. Code review: `/simplify` (quality/reuse) + `/security-review` (security audit)

**Visual verification:** The verifier checks tool availability at runtime (`which maestro`, `which npx`) before attempting MCP interactions. If tools aren't installed or MCP servers aren't running, Level 2 is skipped gracefully. See `docs/VISUAL-VERIFICATION-SETUP.md` for configuration.

**Token budget:** Use `inspect_view_hierarchy` (~50 tokens) over `take_screenshot` (~1600 tokens) when layout-only checks suffice. Limit to 3 screenshots per verification. Never run `maestro test` via Bash while Maestro MCP is active (port 7001 conflict).

