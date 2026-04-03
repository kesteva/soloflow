# SoloFlow

Hooks-based workflow orchestration for solo product development with Claude Code.

Automates the full product development lifecycle: **idea extraction → refinement → execution → verification → learning**.

## Installation

**Per-project (recommended):**
```bash
git clone https://github.com/krishna/soloflow .claude/soloflow
```

**Then initialize the task directory:**
```bash
bash .claude/soloflow/scripts/init.sh
```

This creates `.tasks/` with the active/archive directory structure for tracking workflow state.

## Commands

| Command | Description |
|---------|-------------|
| `/soloflow-start` | Full pipeline — idea through execution and verification |
| `/soloflow-quick` | Lightweight bugfix path — skip refinement |
| `/soloflow-status` | Show current sprint state |
| `/soloflow-verify` | Run visual verification only |

## Architecture

SoloFlow orchestrates a 5-phase workflow using Claude Code hooks and agent definitions:

1. **Idea Extraction** — raw input → structured task spec
2. **Task Refinement** — task spec → execution-ready plan
3. **Execution Sprint** — parallel executor + verifier agents
4. **Human Review** — batched taste-level review
5. **Compound Learning** — extract reusable patterns

Agents are coordinated via an orchestrator with executors and verifiers as leaf nodes. Visual verification uses Maestro MCP (mobile) and Playwright MCP (web).

See `workflow-implementation-plan.md` for the full design.

## License

MIT
