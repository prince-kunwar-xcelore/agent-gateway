# Plan: `install-service` CLI Subcommand

## Goal
Add an `install-service` subcommand to the CLI that automates setting up
claude-token-proxy as a persistent background service on the local machine.
No manual systemd unit editing or launchd plist writing.

---

## Invocation

```bash
# Install and start
bun src/index.ts install-service --public-key ./public.pem --port 7432

# Remove the service
bun src/index.ts install-service --uninstall
```

---

## Platform Support

| Platform       | Mechanism                          | Scope        |
|----------------|------------------------------------|--------------|
| Linux (systemd)| `~/.config/systemd/user/`          | User service |
| macOS          | `~/Library/LaunchAgents/`          | User agent   |
| Windows        | Out of scope (not a CI use case)   | —            |

Detect platform via `process.platform` (`linux` / `darwin`).

---

## What the Command Does

### `install-service` (install + enable + start)

1. Resolve the absolute path to the bun/node executable and the project root
2. Write the platform service file to the correct location
3. Enable + start the service via the platform daemon manager
4. Print the health check URL and run `curl /health` to confirm it's live

### `install-service --uninstall`

1. Stop + disable the service via the platform daemon manager
2. Delete the service file
3. Confirm removal

---

## Linux: systemd User Service

**File written to:**
`~/.config/systemd/user/claude-token-proxy.service`

**Content (generated dynamically):**
```ini
[Unit]
Description=Claude Token Proxy
After=network.target

[Service]
WorkingDirectory=<project-root>
ExecStart=<bun-path> src/index.ts serve --public-key <public-key-path> --port <port>
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

**Commands run:**
```bash
systemctl --user daemon-reload
systemctl --user enable claude-token-proxy
systemctl --user start claude-token-proxy
```

**Uninstall commands:**
```bash
systemctl --user stop claude-token-proxy
systemctl --user disable claude-token-proxy
rm ~/.config/systemd/user/claude-token-proxy.service
systemctl --user daemon-reload
```

---

## macOS: launchd LaunchAgent

**File written to:**
`~/Library/LaunchAgents/com.claude-token-proxy.plist`

**Content (generated dynamically):**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-token-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string><bun-path></string>
    <string><project-root>/src/index.ts</string>
    <string>serve</string>
    <string>--public-key</string>
    <string><public-key-path></string>
    <string>--port</string>
    <string><port></string>
  </array>
  <key>WorkingDirectory</key>
  <string><project-root></string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string><home>/.agent-gateway/proxy.log</string>
  <key>StandardErrorPath</key>
  <string><home>/.agent-gateway/proxy-error.log</string>
</dict>
</plist>
```

**Commands run:**
```bash
launchctl load ~/Library/LaunchAgents/com.claude-token-proxy.plist
```

**Uninstall commands:**
```bash
launchctl unload ~/Library/LaunchAgents/com.claude-token-proxy.plist
rm ~/Library/LaunchAgents/com.claude-token-proxy.plist
```

---

## File Structure

Only one new file needed:

```
src/commands/install-service.ts    — runInstallService(args) + runUninstall()
```

Helpers it uses that already exist:
- `src/args.ts`              — `getArg`, `hasFlag`

Internal helpers to add inside `install-service.ts`:
- `detectRuntime()`          — finds bun or node executable path (`which bun` / `which node`)
- `writeSystemdUnit()`       — writes the `.service` file
- `writeLaunchdPlist()`      — writes the `.plist` file
- `runCmd(cmd)`              — thin wrapper around `execSync` with stdio: inherit

---

## Implementation Order

1. `src/commands/install-service.ts`
   - `detectRuntime()` — resolve bun/node path
   - `writeSystemdUnit()` — generate + write unit file, create `~/.config/systemd/user/` if needed
   - `writeLaunchdPlist()` — generate + write plist file, create log dir
   - `runInstallService(args)` — orchestrate: write file → daemon commands → health check
   - `runUninstall()` — stop → disable → delete → reload

2. Wire into `src/index.ts`
   - Add `install-service` case to switch
   - Add to help text

---

## Key Pitfalls

- **Absolute paths required** — systemd and launchd both need fully resolved paths for
  `ExecStart` and `WorkingDirectory`; never use relative paths in the service file
- **`loginctl enable-linger`** — on some Linux setups user services don't start on boot
  without linger enabled; print a warning + the fix command if detected
- **Bun not on PATH in service** — `PATH` may differ in the service environment vs the
  shell; always resolve the full bun path with `which bun` and embed it in `ExecStart`
- **Already installed** — check for an existing service file before writing; prompt to
  overwrite or `--force` flag to skip the prompt
- **Port already in use** — not the installer's job to validate, but print the `health`
  URL after start so the user can confirm immediately
