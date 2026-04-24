# Visual Verification Setup

This guide covers how to configure the **Maestro CLI** (mobile) and **Playwright MCP** (web) for SoloFlow's visual verification.

Since SoloFlow 0.9.3, mobile visual verification runs via the Maestro CLI directly — no MCP server required. Only Playwright (web) still uses an MCP server.

## Prerequisites

### Maestro (Mobile)

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

4. **Have a simulator/emulator running** with your app installed.

### Screenshot dependencies (mobile)

SoloFlow captures screenshots using native platform tools:

- **iOS:** `xcrun simctl io booted screenshot` — ships with **Xcode Command Line Tools** (`xcode-select --install`).
- **Android:** `adb exec-out screencap -p` — ships with **Android Studio** / `platform-tools`.
- **Downsize:** `sips -Z 1400` — built into macOS. On Linux, substitute ImageMagick `convert -resize 1400x`, or skip downsizing.

### Playwright (Web)

1. **Ensure Node.js is installed** (`which npx` should return a path).

2. No additional installation needed — Playwright MCP runs via `npx @playwright/mcp@latest`.

## MCP Configuration

Only Playwright needs MCP registration. Maestro runs directly via `maestro test` / `maestro hierarchy`.

Note: the shadow verifier agents' `tools:` arrays explicitly list `mcp__playwright__*` — `mcpServers:` alone does not grant tool access (Claude Code treats `tools:` as a strict allowlist). Registering the MCP server below is necessary but not sufficient; the shadow agents must also be synced into `.claude/agents/` via `/soloflow:sync-agents`.

### Plugin-based (when SoloFlow is installed as a Claude Code plugin)

The `.mcp.json` file in the SoloFlow root declares the Playwright MCP server. Claude Code discovers it automatically when the plugin is installed.

### Manual (when using symlinks)

Add the Playwright MCP server to your project's `.claude/settings.json` or `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

Or add to your global `~/.claude/settings.json` to make it available in all projects.

## Enabling Visual Verification

In `config/defaults.yaml` (or via `/soloflow:config`), set the toggles:

```yaml
verification:
  visual_mobile: true    # for Maestro CLI
  visual_web: true       # for Playwright MCP
  visual_mobile_app_id: com.example.myapp   # optional — bundle ID for ad-hoc flows
```

The verifier agent checks these toggles before attempting visual verification. Even if tools are installed, visual verification is skipped unless the toggles are enabled.

`visual_mobile_app_id` is optional. If unset, the verifier grep-detects `appId:` from existing Maestro flows. Set it explicitly for greenfield projects that don't have flows yet.

## Sandbox Permissions

If Claude Code blocks any Maestro-adjacent command, add them to your allow list in settings:

```json
{
  "permissions": {
    "allow": [
      "Bash(maestro *)",
      "Bash(java *)",
      "Bash(xcrun simctl io *)",
      "Bash(sips *)",
      "Bash(adb *)"
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

Maestro requires a running iOS Simulator or Android emulator.

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

### Multiple iOS simulators booted

`maestro` and `xcrun simctl io booted` error with "multiple booted devices" when ≥2 iOS simulators are booted. Either shut down the extras:
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

1. `which maestro` — is the CLI on PATH?
2. `xcrun simctl list devices booted | grep -c Booted` (iOS) or `adb devices | awk '$2=="device"' | wc -l` (Android) — is at least one device booted?
3. Is the app installed on the device, and does your flow `launchApp` step reference its bundle ID correctly?
4. If you set `verification.visual_mobile_app_id`, does it match the bundle ID installed on the simulator?

If all those pass and verification still degrades, run `maestro hierarchy` manually — the failure mode will be reported directly.

### Every web task emits `skipped_unable` despite Playwright being registered

If `claude mcp list` shows `playwright: ✓ Connected` (main session has the server) but every verifier in your sprint marks `visual_web: skipped_unable`, the cause is almost certainly that `shadow-verifier` / `shadow-sprint-verifier` aren't installed in `.claude/agents/`. Claude Code does NOT honor the `mcpServers:` frontmatter key for plugin-scoped subagents — it's silently ignored. SoloFlow's verifier agents therefore ship only under the `shadow-` prefix and must live in project scope to receive Playwright/context7 bindings.

**Fix:** re-run `/soloflow:sync-agents` (or `/soloflow:init`). After sync, **restart Claude Code** — the subagent list is loaded at session start, so freshly-copied agents are not picked up until the next session.

Verify the shadow copies are in place:
```bash
ls .claude/agents/
# Expected: shadow-verifier.md, shadow-sprint-verifier.md, shadow-researcher.md, shadow-roadmap-researcher.md
```

Why the `shadow-` prefix: earlier versions attempted to override plugin `verifier` / `sprint-verifier` agents with same-named project-local shadows, relying on Claude Code's documented project-first precedence. That precedence did not hold reliably in practice — plugin agents sometimes won and the MCP bindings were lost. The `shadow-` prefix removes the ambiguity entirely: orchestrators spawn `shadow-verifier` by name, and the plugin doesn't ship any non-shadow version to collide with.

### Removing a stale Maestro MCP registration

SoloFlow 0.9.3+ does not use the Maestro MCP server. If your `claude mcp list` still shows `maestro`, the registration is inert — harmless to leave. To clean it up:
```bash
claude mcp remove maestro
```
