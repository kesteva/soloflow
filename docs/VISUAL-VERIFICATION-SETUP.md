# Visual Verification Setup

This guide covers how to configure Maestro MCP (mobile) and Playwright MCP (web) for SoloFlow's visual verification.

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

### Playwright (Web)

1. **Ensure Node.js is installed** (`which npx` should return a path).

2. No additional installation needed — Playwright MCP runs via `npx @playwright/mcp@latest`.

## MCP Configuration

### Plugin-based (when SoloFlow is installed as a Claude Code plugin)

The `.mcp.json` file in the SoloFlow root declares both MCP servers. Claude Code discovers these automatically when the plugin is installed.

### Manual (when using symlinks)

Add the MCP servers to your project's `.claude/settings.json` or `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "maestro": {
      "command": "maestro",
      "args": ["mcp"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

Or add to your global `~/.claude/settings.json` to make them available in all projects.

## Enabling Visual Verification

In `config/defaults.yaml`, set the toggles:

```yaml
verification:
  visual_mobile: true    # for Maestro
  visual_web: true       # for Playwright
```

The verifier agent checks these toggles before attempting visual verification. Even if MCP servers are configured, visual verification is skipped unless the toggles are enabled.

## Sandbox Permissions

If Claude Code blocks `maestro` or `java` commands, add them to your excluded commands in settings:

```json
{
  "permissions": {
    "allow": [
      "Bash(maestro *)",
      "Bash(java *)"
    ]
  }
}
```

## Troubleshooting

### Port 7001 conflict
Maestro MCP and `maestro test` (CLI) both use port 7001. If you get a port conflict:
```bash
lsof -i :7001
kill <PID>
```
Never run `maestro test` via Bash while Maestro MCP tools are active.

### Simulator not found
Maestro requires a running iOS Simulator or Android emulator. Start one before running visual verification:
```bash
# iOS
open -a Simulator

# Android
emulator -avd <name>
```

### Maestro not on PATH
If `which maestro` returns nothing but Maestro is installed:
```bash
export PATH="$PATH:$HOME/.maestro/bin"
```
Add this to your shell profile (`~/.zshrc` or `~/.bashrc`) to make it permanent.

### MCP server not starting
Check that the MCP server command works directly:
```bash
maestro mcp          # Should start without errors
npx @playwright/mcp@latest  # Should start without errors
```
