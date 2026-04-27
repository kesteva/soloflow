# SoloFlow

Soloflow is a hooks-based workflow orchestration for solo product development with Claude Code.

It's built specifically to address some of the limitations of using Claude Code as a solo developer work on side projects and aims to solve two core problems:
1) **No time to babysit:** to be useful, Claude needs to be able to run autonomously for long stretches. You're using it for side projects, you don't have time to constantly babysit, approve permissions, and ask it to move along to the next stage
2) **Limited time to review:** because you might only have a 30 minutes or an hour in a day to make progress. You don't have time to do constant QA, read every line of output, or deal with correcting sloppy work. Your time reviewing should be spent on the things that need actual human input. 

To address this, Soloflow automates the product development lifecycle through five stages: **idea extraction → refinement → execution → verification → learning**. Each stage is designed so you provide input at the beginning and then the agent runs autonomously while you walk away. Check in occasionally in your terminal or from your phone to tee up the next stage. 

## Some warnings

- **This is my personal workflow tool.** I build it for how I ship products, and I made it public so others can learn from it, fork it, or run it on their own projects. I'm happy to review issues and PRs, but I only merge changes that help *my* workflow. If something you want doesn't fit that, fork it — the MIT license makes that easy. See [Contributing](docs/CONTRIBUTING.md) for details.
- **It's still in alpha.** this is still under development and has plenty of rough edges. Use it and experiment with it accordingly. 
- **It's hungry.** you will trade tokens for time. The system adds a lot of checks and redundancy so *you* don't have to, but it will burn through tokens as a result. You will at a minimum need a max $100 plan and probably be tempted to get a max $200. 
- **Visual verification is tetchy.** Visual verification is a game changer when it works, but it can be finicky to get set up and working correctly. The workflow will gracefully fall back to standard verification if it's not available so you'll still get the benefits of requirements verification and code review, but it might take some iteration cycles to get it up and running correctly.
- **It's Claude all the way down.** This plugin was created using Claude by telling Claude how I wanted to work better with Claude. There are no artisanally hand crafted lines of code here. In this house we trust (but verify) the machines. 

With that said, even with the rough edges, it works.


## Quick Start

The fastest way to get started is to install the plugin inside Claude Code (two steps — add the marketplace, then install):

```
/plugin marketplace add kesteva/soloflow
/plugin install soloflow@soloflow
```

By default this installs at **user scope** — available in every project on your machine. To scope it to a single project, use the CLI form with `--scope project`:

```
claude plugin install soloflow@soloflow --scope project
```

Alternatively, you install the plugin by opening /plugins within Claude Code, adding the marketplace, and then installing the plugin through there.

Once you've installed the plugin, run `/soloflow:init` to initialize the project. This will create a `.soloflow/` directory which holds all workflow files. 

From there, you can tackle a simple task using `/soloflow:quick`, for example:

```
/soloflow:quick "fix the loading indicator on the character generation screen which currently shows a question mark"
```

This will take a single task through the execution -> verification -> review loop. 

To test on the full workflow, go through four commands in sequence: 
- `/soloflow:idea-extractor`: use this to capture an idea that Claude will then refine. It will ask you questions to understand your intent.
- `/soloflow:planner` this turns the idea into execution ready tasks for Claude. 
- `/soloflow:sprint` takes tasks through the execution -> verification -> review loop
- `/soloflow:compound` optional final stage, but extracts learnings from your sprint including clean-up items, tasks to add to the backlog, and improvements to your project documentation.

If you are working in an established project, an optional first step is to run `/soloflow:map-codebase` which will create Architecture and Code Patterns documentation for your project as well as nested claude.md's where applicable. If you don't want it editing or creating your Claude.md then call it with flag `--skip-claudemd`. 

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

## How It Works

SoloFlow orchestrates 5 phases, each with a specialized agent:

1. **Idea Extraction** — An idea extractor (Sonnet) parses your raw input, searches the codebase for context, and produces a structured idea spec. You review and approve it.

2. **Task Refinement** — A task refiner (Opus) turns the approved idea into execution-ready plans with file ownership, acceptance criteria, and dependency mapping. You review the plans.

3. **Execution Sprint** — An executor (Sonnet) implements each task while a verifier (Opus) checks the work. The executor→verifier loop retries up to 3 times. Tasks that pass are archived; stuck tasks get reports.

4. **Human Review** — You do a taste-level review of completed work. All functional verification has already been done by the verifier — you're checking if it *feels* right.

5. **Compound Learning** — A compounder (Sonnet) extracts reusable patterns from the sprint into solution files for future sessions.

The main session acts as the orchestrator. All agents run as leaf-node subagents. See [Architecture](docs/ARCHITECTURE.md) for the full design.

## Commands

| Command | When to Use |
|---------|-------------|
| `/soloflow:init` | One-time setup — scaffold `.soloflow/` state in the current project |
| `/soloflow:map-codebase` | One-time setup — scaffold missing `CLAUDE.md`, `ARCHITECTURE.md`, and `CODE-PATTERNS.md` so agents have shared context to load |
| `/soloflow:config` | Interactive walkthrough of every SoloFlow setting; writes `.soloflow/config.json` |
| `/soloflow:idea-extractor <description>` | Phase 1 — extract a structured idea from raw input, with optional research |
| `/soloflow:planner <IDEA-NNN>` | Phase 2 — refine an approved idea into execution-ready task plans |
| `/soloflow:sprint [IDEA-NNN or TASK list]` | Phase 3 — run an execution sprint (executor → verifier → code reviewer) |
| `/soloflow:compound [SPRINT-NNN]` | Phase 5 — extract reusable learnings from a completed sprint |
| `/soloflow:quick <task>` | Fast path for simple changes — skips idea extraction and refinement but still provides the scaffolding of execution and verification|
| `/soloflow:bugfix <bug>` | Similar to quick but focused specifically on resolving bugs, puts Claude into bughunting mode first before going through the rest of the execution -> verification flow|
| `/soloflow:status` | Check current sprint state, task progress, and review queue |
| `/soloflow:verify` | Run visual verification standalone (requires Maestro or Playwright) |

## Configuration

All configurable values are documented in `config/defaults.yaml`:

- **Models** — which Claude model each agent uses (Opus vs Sonnet)
- **Limits** — retry caps, checkpoint intervals, max sprint size
- **Verification** — toggle tests, type checking, linting, and visual verification
- **Paths** — state directory locations

Values are embedded in agent and hook source files. To customize, edit the relevant file directly. See [Customization](docs/CUSTOMIZATION.md) for details on every option.

## Visual Verification

SoloFlow can optionally verify work visually using:
- **Maestro MCP** or **Maestro CLI** for mobile apps (React Native, Expo, native)
- **Playwright MCP** for web apps

Visual verification is disabled by default because it requires additional third party libraries (Playwright for web and Maestro for mobile) See [Visual Verification Setup](docs/VISUAL-VERIFICATION-SETUP.md) for installation and configuration. 

It can be finicky and because of the way Claude scopes permissions for plugin agents you need to separately install shadow agents into your project `.claude/` directory. For Maestro, if you don't do this there is a CLI fallback but for Playwright there is not. 

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
