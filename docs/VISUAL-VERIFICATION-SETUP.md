# Visual Verification Setup

This guide covers how to configure visual verification for SoloFlow:

- **Mobile (Maestro)** — **MCP preferred, CLI fallback.** The verifier picks a path once per run: `mcp__maestro__*` if bound to the subagent session, else the `maestro` CLI. Both work; MCP is ~4–10× cheaper on hierarchy tokens and avoids the tmp-file ephemeral-flow dance.
- **Web (Playwright)** — MCP only. No CLI fallback.
- **macOS (Peekaboo)** — **MCP preferred, CLI fallback.** The verifier picks a path once per run: `mcp__peekaboo__*` if bound to the subagent session, else the `peekaboo` CLI. Both work; the JSON-only CLI form is the cheapest way to inspect element state, while `see` returns image + a11y JSON when pixels are needed.

## Prerequisites

### Maestro (Mobile)

Install the Maestro CLI (required for MCP *and* CLI mode — the MCP server is shipped inside the CLI):

1. **Install Maestro CLI:**
   ```bash
   curl -Ls "https://get.maestro.mobile.dev" | bash
   ```

2. **Verify installation:**
   ```bash
   maestro --version
   ```

3. **Ensure `maestro` is on PATH.** The installer adds `~/.maestro/bin` to your shell profile. If `which maestro` returns nothing, add it manually:
   ```bash
   export PATH="$PATH:$HOME/.maestro/bin"
   ```

4. **Have a simulator/emulator running** with your app installed. (The MCP path's `start_device` tool can also boot one on demand, but most users boot explicitly.)

### Screenshot dependencies (mobile, CLI fallback path only)

If the verifier falls back to CLI mode, it captures screenshots using native platform tools:

- **iOS:** `xcrun simctl io booted screenshot` — ships with **Xcode Command Line Tools** (`xcode-select --install`).
- **Android:** `adb exec-out screencap -p` — ships with **Android Studio** / `platform-tools`.
- **Downsize:** `sips -Z 1400` — built into macOS. On Linux, substitute ImageMagick `convert -resize 1400x`, or skip downsizing.

MCP mode takes screenshots through `mcp__maestro__take_screenshot` and needs none of these.

### Playwright (Web)

1. **Ensure Node.js is installed** (`which npx` should return a path).

2. No additional installation needed — Playwright MCP runs via `npx @playwright/mcp@latest`.

### Peekaboo (macOS)

1. **Install the Peekaboo CLI** (used as the CLI fallback path; also brings the bundled tooling for the MCP server):
   ```bash
   brew install steipete/tap/peekaboo
   ```

2. **Verify installation:**
   ```bash
   peekaboo --version
   ```

3. **Ensure Node.js is installed** (`which npx` should return a path). Peekaboo's MCP server runs via `npx @steipete/peekaboo`. If npx is missing, only the CLI fallback path is available — that still works for verification, just without the structured MCP tool surface.

4. **Grant Accessibility and Screen Recording permissions** to the parent process (Terminal, iTerm, or the Claude Code desktop app — whichever is running this Claude Code session):
   - System Settings → Privacy & Security → **Accessibility** → toggle on the parent process
   - System Settings → Privacy & Security → **Screen Recording** → toggle on the parent process
   - After granting, restart the parent process — both grants are read at process start
   - Verify with: `peekaboo permissions`

5. **macOS 15+ required.** Peekaboo uses macOS 15+ Accessibility APIs. Older versions of macOS are not supported.

6. **Build the app you intend to verify.** Peekaboo drives apps that are already installed. For a project under development, build the `.app` bundle (`xcodebuild` or run from Xcode once) and ensure it launches successfully on its own before invoking verification — Peekaboo can launch it, but cannot build it.

## MCP Configuration

Maestro, Playwright, and Peekaboo can each run as MCP servers. `/soloflow:init` detects what's missing and offers to register each — skipping is always an option (Maestro and Peekaboo fall back to their CLIs; Playwright degrades to `skipped_unable`).

Note: the shadow verifier agents' `tools:` arrays explicitly list `mcp__maestro__*`, `mcp__playwright__*`, and `mcp__peekaboo__*` — `mcpServers:` alone does not grant tool access (Claude Code treats `tools:` as a strict allowlist). Registering the MCP servers is necessary but not sufficient; the shadow agents must also be synced into `.claude/agents/` via `/soloflow:sync-agents`.

### Plugin-based (when SoloFlow is installed as a Claude Code plugin)

The plugin does NOT ship a bundled `.mcp.json` — that would collide for any user who already has `maestro`, `playwright`, or `peekaboo` registered. Run `/soloflow:init` to walk through registration interactively.

### Manual

**User scope (recommended — all projects):**
```bash
claude mcp add --scope user maestro maestro mcp
claude mcp add --scope user playwright npx @playwright/mcp@latest
claude mcp add --scope user peekaboo npx -y @steipete/peekaboo
```

**Project scope (this project only — writes `.mcp.json` in the project root):**
```bash
claude mcp add --scope project maestro maestro mcp
claude mcp add --scope project playwright npx @playwright/mcp@latest
claude mcp add --scope project peekaboo npx -y @steipete/peekaboo
```

Or, for project scope, write `.mcp.json` directly:

```json
{
  "mcpServers": {
    "maestro": {
      "type": "stdio",
      "command": "maestro",
      "args": ["mcp"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "peekaboo": {
      "command": "npx",
      "args": ["-y", "@steipete/peekaboo"]
    }
  }
}
```

## Enabling Visual Verification

In `config/defaults.yaml` (or via `/soloflow:config`), set the toggles:

```yaml
verification:
  visual_mobile: true    # for Maestro (MCP preferred, CLI fallback)
  visual_web: true       # for Playwright MCP
  visual_macos: true     # for Peekaboo (MCP preferred, CLI fallback)
  visual_mobile_app_id: com.example.myapp   # optional — bundle ID for ad-hoc flows
```

The verifier agent checks these toggles before attempting visual verification. Even if tools are installed, visual verification is skipped unless the toggles are enabled.

`visual_mobile_app_id` is optional. If unset, the verifier grep-detects `appId:` from existing Maestro flows. Set it explicitly for greenfield projects that don't have flows yet.

## Authenticating the simulator

If your app requires sign-in before any visual flow makes sense (most apps with chat, profile, or session-bound features), the simulator must be authenticated before the verifier runs. There are three paths:

### Manual sign-in

Sign in to the app on the simulator once before invoking `/soloflow:sprint`. This is the simplest path but easy to forget — workspace resets, parallel sprints touching different simulators, and cold-booted devices all drop the session. If the verifier hits a sign-in screen mid-flow, every mobile task in the sprint will emit `visual_mobile: skipped_unable`.

### Fixture-driven sign-in (recommended)

Drop a Maestro flow at `.maestro/fixtures/sign-in.yaml` (or any path you prefer) that signs the test account into your app. Then point `verification.visual_auth_fixture` at it in `.soloflow/config.json` (or `config/defaults.yaml`):

```json
{
  "verification": {
    "visual_mobile": true,
    "visual_auth_fixture": ".maestro/fixtures/sign-in.yaml"
  }
}
```

Skeleton (adapt selectors to your app):

```yaml
appId: com.example.myapp
---
- launchApp
- tapOn: "Email"
- inputText: "test@example.com"
- tapOn: "Password"
- inputText: "<test-account-password>"
- tapOn: "Sign In"
- assertVisible: "<post-login affordance, e.g. Home tab>"
```

The verifier runs this fixture once per session before any visual flow. If the simulator is already signed in, the trailing `assertVisible` returns instantly and the fixture is a cheap no-op. **Use a test account, never production credentials** — the YAML is committed to the project.

### Neither set

When `visual_mobile=true` and `visual_auth_fixture` is null, the orchestrator surfaces a one-line advisory at Step 2.8 (`Advisory (maestro/no_auth_fixture): ...`) so you know auth handling is unconfigured. If the simulator is signed-out, every affected task emits `visual_mobile: skipped_unable` with `dedup_key: simulator_unauthenticated`. The review queue collapses those into a single row covering all affected tasks via `affected_tasks`. Clear the row via `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/review-queue.js" remove --task <task-id>` once you've fixed sign-in.

## Sandbox Permissions

The MCP path needs no Bash permissions. If Claude Code blocks any Maestro-adjacent command during a CLI-fallback run, add them to your allow list in settings:

```json
{
  "permissions": {
    "allow": [
      "Bash(maestro *)",
      "Bash(java *)",
      "Bash(xcrun simctl io *)",
      "Bash(sips *)",
      "Bash(adb *)",
      "Bash(peekaboo *)"
    ]
  }
}
```

## Troubleshooting

### Maestro not on PATH
If `which maestro` returns nothing but Maestro is installed:
```bash
export PATH="$PATH:$HOME/.maestro/bin"
```
Add this to your shell profile (`~/.zshrc` or `~/.bashrc`) to make it permanent.

### No simulator/emulator booted

Maestro requires a running iOS Simulator or Android emulator (for both MCP and CLI paths).

**iOS:**
```bash
open -a Simulator
# or, explicitly:
xcrun simctl list devices               # list available
xcrun simctl boot <UDID>                # boot a specific one
```

**Android:**
```bash
emulator -list-avds
emulator -avd <name>
```

Verify at least one device is booted:
```bash
xcrun simctl list devices booted | grep -c Booted
adb devices | awk '$2=="device"' | wc -l
```

MCP's `start_device` tool can also boot one programmatically from inside a verification run.

### Multiple iOS simulators booted

Both paths error on ambiguous device selection. CLI:
```
"multiple booted devices"
```
MCP: explicit `device_id` from `list_devices` is already required. CLI fallback:
```bash
xcrun simctl shutdown <UDID>
```
or target one explicitly:
```bash
maestro --device <UDID> test flow.yaml
xcrun simctl io <UDID> screenshot shot.png
```

### Playwright MCP server not starting

Check that the MCP server command works directly:
```bash
npx @playwright/mcp@latest  # should start without errors
```

### Every mobile task emits `skipped_unable` despite Maestro being installed

Check the following in order:

0. Is the simulator signed into your app? If your app requires auth, see [Authenticating the simulator](#authenticating-the-simulator) above. A signed-out simulator now collapses to a single deduped queue row (`dedup_key: simulator_unauthenticated`) instead of one row per task — check `.soloflow/human-review-queue.md` for that entry before chasing MCP issues.
1. `claude mcp list | grep -i maestro` — is the MCP server registered? Registering it is optional, but if you intended to use MCP mode and shadow agents aren't current, the verifier silently falls back to CLI. If you want MCP specifically, register + sync shadows.
2. `which maestro` — is the CLI on PATH? (Required for both MCP and CLI modes.)
3. `xcrun simctl list devices booted | grep -c Booted` (iOS) or `adb devices | awk '$2=="device"' | wc -l` (Android) — is at least one device booted?
4. Is the app installed on the device, and does your flow `launchApp` step reference its bundle ID correctly?
5. If you set `verification.visual_mobile_app_id`, does it match the bundle ID installed on the simulator?

If all those pass and verification still degrades, run `maestro hierarchy` manually — the failure mode will be reported directly.

### Every mobile task degrades to CLI mode despite Maestro MCP being registered

If `claude mcp list` shows `maestro: ✓ Connected` (main session has the server) but every verifier falls back to the CLI path, the cause is almost certainly that `shadow-verifier` / `shadow-sprint-verifier` aren't installed in `.claude/agents/` (or the copies there are stale). Claude Code does NOT honor the `mcpServers:` frontmatter key for plugin-scoped subagents — it's silently ignored. SoloFlow's verifier agents therefore ship only under the `shadow-` prefix and must live in project scope to receive Maestro/Playwright/context7 bindings.

**Fix:** re-run `/soloflow:sync-agents` (or `/soloflow:init`). After sync, **restart Claude Code** — the subagent list is loaded at session start, so freshly-copied agents are not picked up until the next session.

Verify the shadow copies are in place:
```bash
ls .claude/agents/
# Expected: shadow-verifier.md, shadow-sprint-verifier.md, shadow-researcher.md, shadow-roadmap-researcher.md
```

### Every web task emits `skipped_unable` despite Playwright being registered

Same root cause as the Maestro MCP case above, but Playwright has no CLI fallback — when the shadows are stale, every web task degrades to `skipped_unable` instead of silently falling back. Re-run `/soloflow:sync-agents` and restart Claude Code.

Why the `shadow-` prefix: earlier versions attempted to override plugin `verifier` / `sprint-verifier` agents with same-named project-local shadows, relying on Claude Code's documented project-first precedence. That precedence did not hold reliably in practice — plugin agents sometimes won and the MCP bindings were lost. The `shadow-` prefix removes the ambiguity entirely: orchestrators spawn `shadow-verifier` by name, and the plugin doesn't ship any non-shadow version to collide with.

### Peekaboo: every macOS task emits `skipped_unable` despite `peekaboo` being installed

Check the following in order:

1. `peekaboo permissions` — are Accessibility and Screen Recording both granted to the parent process (Terminal / Claude Code)? Permissions are read at process start; if you just granted them, restart the parent process before retrying.
2. `claude mcp list | grep -i peekaboo` — is the MCP server registered? Registering it is optional (CLI fallback works), but if you intended to use MCP mode and shadow agents aren't current, the verifier silently falls back to CLI. If you want MCP specifically, register + sync shadows.
3. `which peekaboo` — is the CLI on PATH? (Required for both MCP and CLI modes — the CLI path is the fallback the verifier reaches for when MCP is unbound.)
4. `which npx` — present? Peekaboo's MCP server runs via `npx -y @steipete/peekaboo`. If npx is missing, register a different command or rely on the CLI fallback only.
5. Is the target app actually installed and launchable? Peekaboo cannot build apps — confirm the `.app` bundle exists and opens normally before running verification.

If all of those pass and verification still degrades, run `peekaboo see --app "<YourApp>" --json-output` manually — the failure mode will be reported directly.

### Peekaboo: "Accessibility permission not granted" or "Screen Recording permission not granted"

The macOS permission grant must target the **parent process** that ultimately runs Claude Code, not Claude Code itself. Common cases:

- **Terminal / iTerm**: grant to Terminal.app or iTerm.app.
- **Claude Code desktop app**: grant to Claude.app (or whatever the binary is named).
- **VS Code with the Claude Code extension**: grant to Code.app.

After granting, **fully quit and relaunch** the parent process. Mac permission grants are read once at process start. Verify with `peekaboo permissions`.

### Peekaboo: MCP not bound to shadow-verifier subagent despite registration

Same root cause as the Maestro and Playwright cases above: plugin-scoped subagents cannot receive MCP tool bindings; the bindings only reach the project-local shadow copies at `.claude/agents/shadow-verifier.md` / `shadow-sprint-verifier.md`. Re-run `/soloflow:sync-agents` after a plugin upgrade and **restart Claude Code** — subagents are loaded at session start.

Peekaboo does have a CLI fallback, so a missing binding silently degrades to CLI mode rather than `skipped_unable` — check shadow currency anyway if you want the MCP path's structured tool surface.

### Reinstalling Maestro MCP after removing it in 0.9.3–0.9.5

SoloFlow 0.9.3–0.9.5 removed the Maestro MCP server from the verifier. If you ran `claude mcp remove maestro` during that window and want the 0.9.7+ MCP-preferred behavior back, register it again:

```bash
claude mcp add --scope user maestro maestro mcp
```

Then run `/soloflow:sync-agents` and restart Claude Code so the updated shadow agents (which declare `mcp__maestro__*` in their tools allowlist) are picked up.
