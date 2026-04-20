# Contributing

## Read this first

**SoloFlow is my personal workflow tool.** I build it to match how I ship products. The code is public so others can learn from it, fork it, or use it on their own projects — not because I'm running an open-source project with a roadmap for contributors.

What this means in practice:

- **Issues and PRs are welcome**, and I will read them. But I only merge changes that help *my* workflow. "It would be nice if X" or "what about a generic Y" will almost always be declined, even if the idea is good.
- **No roadmap commitments.** I ship what I need, when I need it. Don't plan work around a feature request being accepted.
- **Breaking changes happen.** I'll refactor or rip things out when it helps me. Pin a commit or fork if you need stability.
- **Fork freely.** MIT license, no strings. If your workflow diverges from mine, your fork is the right place to build it.

If you're unsure whether a change will land, open an issue describing your use case before investing time in a PR.

## Reporting Issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Which workflow phase it occurred in (idea extraction, refinement, execution, etc.)
- Your Claude Code version

Bug reports against the core flow are genuinely helpful — they surface things I'd hit eventually anyway.

## Suggesting Features

Open an issue before submitting a PR. Describe the problem you're solving, not just the solution you want. I'll tell you early whether it's something I'd merge, so you don't waste time.

Feature requests that are most likely to land:
- Fixes for friction I'd also hit in my own workflow
- Small, composable additions that don't expand scope
- Documentation improvements that clarify existing behavior

Feature requests that will probably be declined:
- New phases, new agent types, or new pipeline stages
- Generalizing something specific (e.g., "make it work for teams")
- Options/flags to support a workflow that differs from mine

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes in small, atomic commits
3. Follow the commit conventions: `type: description`
   - Types: `feat`, `fix`, `docs`, `chore`, `refactor`
4. Open a PR with a clear description of what changed and why

I'll review when I have time. No SLA.

## Code Conventions

- **Hooks** (`hooks/`): Plain Node.js, no external dependencies. Read stdin JSON, output JSON to stdout. Always exit 0 unless intentionally blocking (exit 2 for quality gates).
- **Agents** (`agents/`): Markdown with YAML frontmatter (`name`, `description`, `model`, `tools`). The prompt is the file body.
- **Commands** (`commands/`): Markdown with YAML frontmatter (`description`, `argument-hint`, `allowed-tools`). Instructions for the main session.
- **Skills** (`skills/`): `SKILL.md` in a named directory. Patterns and instructions for specific capabilities.
- **Config**: YAML format in `config/`.
- **Naming**: Files inside `agents/`, `commands/`, `hooks/`, and `skills/` are *not* prefixed — the `soloflow` plugin namespace is applied at invocation time (e.g. `/soloflow:planner`, skill id `soloflow:visual-verify`).

## Testing

There is no automated test suite — SoloFlow is session-based tooling tested by running it against real projects. To test changes:

1. Install SoloFlow in a scratch project (`bash scripts/install.sh`)
2. Start a Claude Code session
3. Run `/soloflow:quick "add a hello world file"` to test the inner loop
4. Run `/soloflow:idea-extractor "add a new feature"` → `/soloflow:planner IDEA-001` → `/soloflow:sprint` → `/soloflow:compound` to test the full pipeline
5. Verify hooks fire (session-start injects state, post-tool-use lints, task-completed runs tests)

## License

MIT. Contributions are made under the same license.
