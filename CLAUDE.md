# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SoloFlow is a hooks-based Claude Code workflow orchestration system that automates the product development lifecycle: idea extraction → refinement → execution → verification → learning. Distributed as a Claude Code plugin (git repo + thin plugin wrapper) installable per-project or globally.

**First test case:** ImagiFable app (React Native/Expo).

## Architecture

Five-phase workflow orchestrated via Claude Code hooks and agent definitions:

1. **Idea Extraction** (Sonnet) — raw input → structured `.tasks/ideas/IDEA-NNN.md`
2. **Task Refinement** (Opus) — idea → execution-ready `.tasks/plans/TASK-NNN-plan.md`
3. **Execution Sprint** — Orchestrator (Opus) coordinates parallel Executor (Sonnet) + Verifier (Opus) subagents via worktrees
4. **Human Review** — batched taste-level review (functional verification already done)
5. **Compound Learning** (Sonnet) — extract reusable patterns → `.tasks/solutions/SOL-NNN.md`

**Key constraint:** Subagents cannot spawn subagents. Orchestrator is main agent; executors/verifiers are leaf nodes only.

### Components

- **`agents/`** — Agent definitions as markdown with YAML frontmatter
- **`hooks/`** — JavaScript Claude Code hooks (session-start, pre-compact, subagent-stop, post-tool-use, task-completed)
- **`commands/`** — Slash command definitions (`/soloflow-start`, `/soloflow-quick`, `/soloflow-status`, `/soloflow-verify`)
- **`skills/`** — Skill definitions (e.g., visual-verify)
- **`templates/`** — Markdown templates for ideas, plans, done reports, reviews, solutions
- **`scripts/`** — Shell scripts (`init.sh`, `ready.sh`, `progress.sh`)
- **`config/`** — `defaults.yaml` configuration

### State Layer

All workflow state lives in `.tasks/` (created per-project by `scripts/init.sh`), split into active and archive:

**`.tasks/active/`** — read during execution:
- `ideas/`, `plans/`, `stuck/` — in-flight task files
- `progress.json` — active sprint state (only current tasks, not historical)

**`.tasks/archive/`** — never read during execution:
- `done/`, `reviews/`, `solutions/` — completed task reports and learnings

**`.tasks/`** root:
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

**Maestro note:** Uses port 7001. Use `inspect_view_hierarchy` (50 tokens) over screenshots (1600+ tokens) when layout-only checks suffice. Never run MCP and YAML flows simultaneously.

## Implementation Plan

Full plan in `workflow-implementation-plan.md`. Five milestones:
1. Foundation — repo scaffolding, state layer, session-start hook
2. Executor + Verifier Loop — inner execution loop, `/soloflow-quick`
3. Visual Verification — Maestro/Playwright integration
4. Full Pipeline — all agents + commands + remaining hooks
5. Polish + Open Source — docs, config, marketplace setup
