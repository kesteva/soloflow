# Changelog

All notable changes to SoloFlow are documented in this file.

## [0.1.0] - 2026-04-04

### Added
- Five-phase workflow: idea extraction, task refinement, execution sprint, human review, compound learning
- 6 agent definitions: orchestrator, executor, verifier, idea-extractor, task-refiner, compounder
- 5 hooks: session-start, post-tool-use, task-completed, pre-compact, subagent-stop
- 4 commands: `/soloflow-start`, `/soloflow-quick`, `/soloflow-status`, `/soloflow-verify`
- Visual verification skill with Maestro MCP (mobile) and Playwright MCP (web)
- State management with active/archive split in `.soloflow/`
- Install script for per-project setup
- Default configuration in `config/defaults.yaml`
- Documentation: architecture, customization, contributing, visual verification setup
