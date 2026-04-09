# SoloFlow

Hooks-based workflow orchestration for solo product development with Claude Code.

Automates the full product development lifecycle: **idea extraction → refinement → execution → verification → learning**. Built for solo developers shipping real products with AI leverage — not a framework, but a workflow that handles the orchestration so you can focus on taste and direction.

## Quick Start

Install the plugin inside Claude Code (two steps — add the marketplace, then install):

```
/plugin marketplace add kesteva/soloflow
/plugin install soloflow@soloflow
```

By default this installs at **user scope** — available in every project on your machine. To scope it to a single project, use the CLI form with `--scope project`:

```
claude plugin install soloflow@soloflow --scope project
```

Start a Claude Code session in your project and initialize state:

```
/soloflow:init
/soloflow:quick "fix the loading indicator showing a question mark"
```

For full features, run the pipeline stage by stage:

```
/soloflow:idea-extractor "add retry UI for failed content generation"
/soloflow:planner IDEA-001
/soloflow:executor
/soloflow:compound
```

## Installation

### Plugin (recommended)

SoloFlow ships as a self-hosted plugin marketplace. From inside Claude Code:

```
/plugin marketplace add kesteva/soloflow
/plugin install soloflow@soloflow
```

The first command registers this repo as a marketplace (reading `.claude-plugin/marketplace.json`). The second installs the `soloflow` plugin from that marketplace.

The plugin auto-discovers agents, commands, hooks, and skills from the repo layout and registers everything automatically. Updates are handled with `/plugin update soloflow@soloflow`. On first session in a project, SoloFlow prompts you to run `/soloflow:init` — nothing is written to your project until you opt in explicitly.

#### Install scope

Plugin scope is a Claude Code feature (not something the plugin controls). You have three options:

| Scope | Flag | Where it's stored | When to use |
|---|---|---|---|
| **User** (default) | `--scope user` | User-level config | You want SoloFlow in every project on this machine |
| **Project** | `--scope project` | `.claude/settings.json` in the repo | You want SoloFlow only for this repo AND want to share the choice with collaborators via git |
| **Local** | `--scope local` | User-only entry for this repo | You want SoloFlow only for this repo and don't want to commit the choice |

You can also open `/plugin` inside Claude Code for an interactive picker that lets you choose scope when installing.

### Script fallback (vendored install)

For CI environments, air-gapped machines, Windows users without Developer Mode, or anyone who prefers explicit control:

```bash
git clone https://github.com/kesteva/soloflow /tmp/soloflow
bash /tmp/soloflow/scripts/install.sh /path/to/your/project
```

This **copies** (not symlinks) agents, commands, skills, and hook scripts into your project's `.claude/` directory, registers hooks in `.claude/settings.json`, writes a `.claude/soloflow-install/VERSION` stamp, and tracks installed files in `.claude/soloflow-install/manifest.json` for idempotent updates.

To update: `bash /tmp/soloflow/scripts/update.sh /path/to/your/project`
To uninstall: `bash /tmp/soloflow/scripts/uninstall.sh /path/to/your/project`

## Commands

| Command | When to Use |
|---------|-------------|
| `/soloflow:init` | One-time setup — scaffold `.soloflow/` state in the current project |
| `/soloflow:idea-extractor <description>` | Phase 1 — extract a structured idea from raw input, with optional research |
| `/soloflow:planner <IDEA-NNN>` | Phase 2 — refine an approved idea into execution-ready task plans |
| `/soloflow:executor [IDEA-NNN or TASK list]` | Phase 3 — run an execution sprint (executor → verifier → code reviewer) |
| `/soloflow:compound [SPRINT-NNN]` | Phase 5 — extract reusable learnings from a completed sprint |
| `/soloflow:quick <bug>` | Fast path for bugfixes — skips idea extraction and refinement |
| `/soloflow:status` | Check current sprint state, task progress, and review queue |
| `/soloflow:verify` | Run visual verification standalone (requires Maestro or Playwright) |

## How It Works

SoloFlow orchestrates 5 phases, each with a specialized agent:

1. **Idea Extraction** — An idea extractor (Sonnet) parses your raw input, searches the codebase for context, and produces a structured idea spec. You review and approve it.

2. **Task Refinement** — A task refiner (Opus) turns the approved idea into execution-ready plans with file ownership, acceptance criteria, and dependency mapping. You review the plans.

3. **Execution Sprint** — An executor (Sonnet) implements each task while a verifier (Opus) checks the work. The executor→verifier loop retries up to 3 times. Tasks that pass are archived; stuck tasks get reports.

4. **Human Review** — You do a taste-level review of completed work. All functional verification has already been done by the verifier — you're checking if it *feels* right.

5. **Compound Learning** — A compounder (Sonnet) extracts reusable patterns from the sprint into solution files for future sessions.

The main session acts as the orchestrator. All agents run as leaf-node subagents. See [Architecture](docs/ARCHITECTURE.md) for the full design.

## Configuration

All configurable values are documented in `config/defaults.yaml`:

- **Models** — which Claude model each agent uses (Opus vs Sonnet)
- **Limits** — retry caps, checkpoint intervals, max sprint size
- **Verification** — toggle tests, type checking, linting, and visual verification
- **Paths** — state directory locations

Values are embedded in agent and hook source files. To customize, edit the relevant file directly. See [Customization](docs/CUSTOMIZATION.md) for details on every option.

## Visual Verification

SoloFlow can optionally verify work visually using:
- **Maestro MCP** for mobile apps (React Native, Expo, native)
- **Playwright MCP** for web apps

Visual verification is disabled by default. See [Visual Verification Setup](docs/VISUAL-VERIFICATION-SETUP.md) for installation and configuration.

## Project Structure

```
soloflow/
├── agents/          # Agent definitions (markdown + YAML frontmatter)
├── commands/        # Slash command definitions
├── hooks/           # Claude Code hooks (Node.js)
├── skills/          # Skill definitions (visual verification)
├── config/          # Default configuration (defaults.yaml)
├── scripts/         # Shell scripts (install.sh, update.sh, uninstall.sh, init.sh)
├── docs/            # Documentation
└── .claude-plugin/  # Plugin manifest
```

State files are created per-project in `.soloflow/` (not tracked in git).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how agents interact, state flow, hook system
- [Customization](docs/CUSTOMIZATION.md) — configuration options, model assignments, verification toggles
- [Contributing](docs/CONTRIBUTING.md) — reporting issues, submitting changes, code conventions
- [Visual Verification Setup](docs/VISUAL-VERIFICATION-SETUP.md) — Maestro and Playwright configuration

## License

MIT
