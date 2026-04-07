# Contributing

## Reporting Issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Which workflow phase it occurred in (idea extraction, refinement, execution, etc.)
- Your Claude Code version

## Suggesting Features

Open an issue before submitting a PR. SoloFlow is intentionally minimal — not every feature request will be accepted. Describe the problem you're solving, not just the solution you want.

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes in small, atomic commits
3. Follow the commit conventions: `type: description`
   - Types: `feat`, `fix`, `docs`, `chore`, `refactor`
4. Open a PR with a clear description of what changed and why

## Code Conventions

- **Hooks** (`hooks/`): Plain Node.js, no external dependencies. Read stdin JSON, output JSON to stdout. Always exit 0 unless intentionally blocking (exit 2 for quality gates).
- **Agents** (`agents/`): Markdown with YAML frontmatter (`name`, `description`, `model`, `tools`). The prompt is the file body.
- **Commands** (`commands/`): Markdown with YAML frontmatter (`description`, `argument-hint`, `allowed-tools`). Instructions for the main session.
- **Skills** (`skills/`): `SKILL.md` in a named directory. Patterns and instructions for specific capabilities.
- **Config**: YAML format in `config/`.
- **Naming**: All files are prefixed with `soloflow-`.

## Testing

There is no automated test suite — SoloFlow is session-based tooling tested by running it against real projects. To test changes:

1. Install SoloFlow in a scratch project (`bash scripts/install.sh`)
2. Start a Claude Code session
3. Run `/soloflow-quick "add a hello world file"` to test the inner loop
4. Run `/soloflow-idea-extractor "add a new feature"` → `/soloflow-planner IDEA-001` → `/soloflow-executor` → `/soloflow-compound` to test the full pipeline
5. Verify hooks fire (session-start injects state, post-tool-use lints, task-completed runs tests)

## License

MIT. Contributions are made under the same license.
