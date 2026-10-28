# Service, config and tunnel CLI

**Status:** Implemented (Linux tested; macOS LaunchAgent untested — see the GitHub issue
"Test macOS LaunchAgent support").

Supersedes the original `install-service` plan. Summary of the design as built:

## Config file
- `~/.agent-gateway/config.json` (dir 0700, file 0600): `port`, `agents`,
  `privateKey {enabled, publicKeyPath}`, `allowlist {enabled, allow, audience}`, optional
  `tunnel {provider, hostname, tunnelName}`. Paths are absolute.
- `serve` loads it (or `--config <path>`); CLI flags override field by field. With no config
  file and no `--allow`, private-key mode falls back to `./public.pem` (original behaviour).
- Written by `init`, `allow add|remove`, `mode enable|disable`, `tunnel setup|remove`. Edits
  restart a running service (`--no-restart` to skip); no hot reload.

## Services
- `src/service.ts` abstracts systemd user units (`systemctl --user`) and launchd LaunchAgents
  (`launchctl bootstrap/bootout/kickstart`, logs to `~/.agent-gateway/<name>.log`).
- The proxy unit runs `<runtime> <entry> serve --config <abs path>`, never mode/allow flags.
  Runtime: the current runtime for built JS; Bun for `.ts` sources if available; otherwise
  `dist/index.js` (requires `pnpm build`) — Node cannot run the `.ts` entry directly.
- Linux boot start requires lingering; `install`/`enable` print the `loginctl` command if off.

## Tunnels
- `tunnel setup cloudflare --hostname` reuses or creates a named tunnel, routes DNS, and writes
  `~/.agent-gateway/cloudflared.yml` (never touches `~/.cloudflared/config.yml`).
- `tunnel setup ngrok --domain` requires the authtoken in ngrok's config file (services don't
  see shell env vars).
- Both run as a second unit, `agent-gateway-tunnel`.

## Possible follow-ups
- Windows support (Task Scheduler or a service wrapper).
- Hot reload on SIGHUP instead of restart.
- Restrict `/health` detail for non-localhost callers.
