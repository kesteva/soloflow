# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SoloFlow is a hooks-based Claude Code workflow orchestration system that automates the product development lifecycle: idea extraction → refinement → execution → verification → learning. Distributed as a Claude Code plugin (git repo + thin plugin wrapper) installable per-project or globally.

**First test case:** ImagiFable app (React Native/Expo).

## Architecture

Five-phase workflow orchestrated via Claude Code hooks and agent definitions:

1. **Idea Extraction** (Sonnet) — raw input → structured `.soloflow/ideas/IDEA-NNN.md`
2. **Task Refinement** (Opus) — idea → execution-ready `.soloflow/plans/TASK-NNN-plan.md`
3. **Execution Sprint** — Orchestrator (Opus) coordinates parallel Executor (Sonnet) + Verifier (Opus) subagents via worktrees
4. **Human Review** — batched taste-level review (functional verification already done)
5. **Compound Learning** (Sonnet) — extract reusable patterns → `.soloflow/solutions/SOL-NNN.md`

**Key constraint:** Subagents cannot spawn subagents. Orchestrator is main agent; executors/verifiers are leaf nodes only.

### Components

- **`agents/`** — Agent definitions as markdown with YAML frontmatter
- **`hooks/`** — JavaScript Claude Code hooks (all prefixed `soloflow-*`)
- **`commands/`** — Slash command definitions (all prefixed `soloflow-*`: `/soloflow-start`, `/soloflow-quick`, `/soloflow-status`, `/soloflow-verify`)
- **`skills/`** — Skill definitions (e.g., `soloflow-visual-verify/`)
- **`.mcp.json`** — MCP server declarations for Maestro and Playwright
- **`templates/`** — Markdown templates for ideas, plans, done reports, reviews, solutions
- **`scripts/`** — Shell scripts (`init.sh`, `ready.sh`, `progress.sh`)
- **`config/`** — `defaults.yaml` configuration

### State Layer

All workflow state lives in `.soloflow/` (created per-project by `scripts/init.sh`), split into active and archive:

**`.soloflow/active/`** — read during execution:
- `ideas/`, `plans/`, `stuck/` — in-flight task files
- `progress.json` — active sprint state (only current tasks, not historical)

**`.soloflow/archive/`** — never read during execution:
- `done/`, `reviews/`, `solutions/` — completed task reports and learnings

**`.soloflow/`** root:
- `checkpoint.md` — context restoration after compaction
- `human-review-queue.md` — batched items for human review

Completed tasks are removed from `progress.json` and their reports move to `archive/done/`.

State format: Markdown with YAML frontmatter (optimized for LLM parsing + git diffs).

## Agent Model Strategy

- **Opus:** Orchestrator, Verifier, Task Refiner (quality-critical roles)
- **Sonnet:** Executor, Idea Extractor, Compounder (cost optimization, ~60% reduction)

## Verification Layer

Multi-layered verification hierarchy (in order of authority):
1. Ground truth: test suite, type checker, linter
2. Visual: Maestro MCP (mobile), Playwright MCP (web)
3. Requirements adherence with concrete evidence
4. Goal-backward: "What must be TRUE for production?"

**Visual verification:** The verifier checks tool availability at runtime (`which maestro`, `which npx`) before attempting MCP interactions. If tools aren't installed or MCP servers aren't running, Level 2 is skipped gracefully. See `docs/VISUAL-VERIFICATION-SETUP.md` for configuration.

**Token budget:** Use `inspect_view_hierarchy` (~50 tokens) over `take_screenshot` (~1600 tokens) when layout-only checks suffice. Limit to 3 screenshots per verification. Never run `maestro test` via Bash while Maestro MCP is active (port 7001 conflict).

## Implementation Plan

Full plan in `workflow-implementation-plan.md`. Five milestones:
1. Foundation — repo scaffolding, state layer, session-start hook
2. Executor + Verifier Loop — inner execution loop, `/soloflow-quick`
3. Visual Verification — Maestro/Playwright integration
4. Full Pipeline — all agents + commands + remaining hooks
5. Polish + Open Source — docs, config, marketplace setup
