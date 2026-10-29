import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GATEWAY_DIR } from './config';

/**
 * User-level service management shared by the proxy and tunnel services.
 *   Linux: systemd user units in ~/.config/systemd/user, driven by `systemctl --user`.
 *   macOS: LaunchAgents in ~/Library/LaunchAgents, driven by `launchctl`.
 *          UNTESTED — written against launchctl's documented bootstrap/bootout API.
 */

export interface ServiceSpec {
  /** Unit / label stem, e.g. "agent-gateway" or "agent-gateway-tunnel". */
  name: string;
  description: string;
  /** Absolute command + arguments. */
  command: string[];
  /** Extra directories for the service's PATH, e.g. where the agent CLIs live. */
  pathDirs?: string[];
}

export interface ServiceState {
  installed: boolean;
  active: boolean;
  enabled: boolean;
  /** Raw manager state for display, e.g. "active (running)". */
  detail: string;
}

export interface ServiceManager {
  unitPath(spec: ServiceSpec): string;
  install(spec: ServiceSpec): void;
  uninstall(spec: ServiceSpec): void;
  start(spec: ServiceSpec): void;
  stop(spec: ServiceSpec): void;
  restart(spec: ServiceSpec): void;
  enable(spec: ServiceSpec): void;
  disable(spec: ServiceSpec): void;
  state(spec: ServiceSpec): ServiceState;
  logs(spec: ServiceSpec, follow: boolean): void;
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    // Surface the tool's own explanation; the top-level handler only prints the message
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`${cmd} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

/** Run and return stdout even when the command exits non-zero (e.g. `systemctl is-active`). */
function query(cmd: string, args: string[]): string {
  return spawnSync(cmd, args, { encoding: 'utf8' }).stdout?.trim() ?? '';
}

/** Absolute path of an executable on PATH, or null. */
export function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    // Empty / relative entries would resolve against the cwd and end up in a unit file
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

// Services start with a minimal PATH; include the directories of the binaries we run.
function servicePath(spec: ServiceSpec): string {
  const dirs = new Set([path.dirname(spec.command[0]), ...(spec.pathDirs ?? []), '/usr/local/bin', '/usr/bin', '/bin']);
  return [...dirs].join(':');
}

// ── systemd (Linux) ──────────────────────────────────────────────────────────

// A newline in a value would start a new directive in the unit file
function rejectControlChars(value: string): void {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`Control characters are not allowed in a unit file value: ${JSON.stringify(value)}`);
}

// Quote for ExecStart; `$` and `%` would otherwise be expanded as variables / specifiers
export const systemdQuote = (arg: string): string => {
  rejectControlChars(arg);
  const escaped = arg.replace(/\$/g, '$$$$').replace(/%/g, '%%');
  return /[\s"'\\]/.test(escaped) ? `"${escaped.replace(/(["\\])/g, '\\$1')}"` : escaped;
};

// Environment= expands `%` specifiers (not `$`); quoting keeps spaces in the value
export const systemdEnv = (name: string, value: string): string => {
  rejectControlChars(value);
  return `"${name}=${value.replace(/%/g, '%%').replace(/(["\\])/g, '\\$1')}"`;
};

const systemd: ServiceManager = {
  unitPath: (spec) => path.join(os.homedir(), '.config', 'systemd', 'user', `${spec.name}.service`),

  install(spec) {
    const unit = `[Unit]
Description=${spec.description.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/%/g, '%%')}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${spec.command.map(systemdQuote).join(' ')}
WorkingDirectory=${GATEWAY_DIR.replace(/%/g, '%%')}
Environment=${systemdEnv('HOME', os.homedir())}
Environment=${systemdEnv('PATH', servicePath(spec))}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(GATEWAY_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.unitPath(spec)), { recursive: true });
    fs.writeFileSync(this.unitPath(spec), unit);
    run('systemctl', ['--user', 'daemon-reload']);
  },

  uninstall(spec) {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${spec.name}.service`]);
    fs.rmSync(this.unitPath(spec), { force: true });
    // The unit file is already gone; a failed reload (e.g. no user bus) only delays systemd noticing
    spawnSync('systemctl', ['--user', 'daemon-reload']);
  },

  start:   (spec) => void run('systemctl', ['--user', 'start', `${spec.name}.service`]),
  stop:    (spec) => void run('systemctl', ['--user', 'stop', `${spec.name}.service`]),
  restart: (spec) => void run('systemctl', ['--user', 'restart', `${spec.name}.service`]),
  enable:  (spec) => void run('systemctl', ['--user', 'enable', `${spec.name}.service`]),
  disable: (spec) => void run('systemctl', ['--user', 'disable', `${spec.name}.service`]),

  state(spec) {
    const installed = fs.existsSync(this.unitPath(spec));
    const active = query('systemctl', ['--user', 'is-active', `${spec.name}.service`]);
    const enabled = query('systemctl', ['--user', 'is-enabled', `${spec.name}.service`]);
    return { installed, active: active === 'active', enabled: enabled === 'enabled', detail: `${active || 'unknown'}, ${enabled || 'unknown'}` };
  },

  logs(spec, follow) {
    spawnSync('journalctl', ['--user', '-u', `${spec.name}.service`, '-n', '100', '--no-pager', ...(follow ? ['-f'] : [])], { stdio: 'inherit' });
  },
};

// ── launchd (macOS) — UNTESTED ───────────────────────────────────────────────

const label = (spec: ServiceSpec): string => `com.${spec.name}`;
const domain = (): string => `gui/${process.getuid?.() ?? 0}`;
const logFile = (spec: ServiceSpec): string => path.join(GATEWAY_DIR, `${spec.name}.log`);

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const launchd: ServiceManager = {
  unitPath: (spec) => path.join(os.homedir(), 'Library', 'LaunchAgents', `${label(spec)}.plist`),

  install(spec) {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(spec)}</string>
  <key>ProgramArguments</key>
  <array>
${spec.command.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(GATEWAY_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xmlEscape(os.homedir())}</string>
    <key>PATH</key><string>${xmlEscape(servicePath(spec))}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xmlEscape(logFile(spec))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile(spec))}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(this.unitPath(spec)), { recursive: true });
    fs.writeFileSync(this.unitPath(spec), plist);
  },

  uninstall(spec) {
    spawnSync('launchctl', ['bootout', `${domain()}/${label(spec)}`]);
    fs.rmSync(this.unitPath(spec), { force: true });
  },

  start(spec) {
    // bootstrap loads (and, with RunAtLoad, starts) the agent; kickstart covers the already-loaded case
    const loaded = spawnSync('launchctl', ['print', `${domain()}/${label(spec)}`]).status === 0;
    if (loaded) run('launchctl', ['kickstart', `${domain()}/${label(spec)}`]);
    else run('launchctl', ['bootstrap', domain(), this.unitPath(spec)]);
  },
  stop:    (spec) => void spawnSync('launchctl', ['bootout', `${domain()}/${label(spec)}`]),
  restart(spec) {
    const loaded = spawnSync('launchctl', ['print', `${domain()}/${label(spec)}`]).status === 0;
    if (loaded) run('launchctl', ['kickstart', '-k', `${domain()}/${label(spec)}`]);
    else this.start(spec);
  },
  // LaunchAgents in ~/Library/LaunchAgents load at login unless disabled
  enable:  (spec) => void run('launchctl', ['enable', `${domain()}/${label(spec)}`]),
  disable: (spec) => void run('launchctl', ['disable', `${domain()}/${label(spec)}`]),

  state(spec) {
    const installed = fs.existsSync(this.unitPath(spec));
    const printed = spawnSync('launchctl', ['print', `${domain()}/${label(spec)}`], { encoding: 'utf8' });
    const active = printed.status === 0 && /state = running/.test(printed.stdout);
    const disabled = new RegExp(`"${label(spec).replace(/\./g, '\\.')}" => (true|disabled)`).test(
      query('launchctl', ['print-disabled', domain()]),
    );
    return { installed, active, enabled: installed && !disabled, detail: `${active ? 'running' : 'not running'}, ${disabled ? 'disabled' : 'enabled'}` };
  },

  logs(spec, follow) {
    spawnSync('tail', ['-n', '100', ...(follow ? ['-f'] : []), logFile(spec)], { stdio: 'inherit' });
  },
};

export function serviceManager(): ServiceManager {
  if (process.platform === 'linux') {
    if (!which('systemctl')) throw new Error('systemctl not found — only systemd is supported on Linux');
    return systemd;
  }
  if (process.platform === 'darwin') return launchd;
  throw new Error(`Service management is not supported on ${process.platform} (Linux systemd and macOS launchd only)`);
}

/**
 * On Linux, user services only start at boot (before login) with lingering.
 * Returns a hint to print when it is off, or null.
 */
export function lingerHint(): string | null {
  if (process.platform !== 'linux') return null;
  const user = os.userInfo().username;
  const linger = query('loginctl', ['show-user', user, '-p', 'Linger']);
  return linger === 'Linger=yes' ? null : `Start on boot needs lingering: sudo loginctl enable-linger ${user}`;
}
