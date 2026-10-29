import { AGENTS, type Agent } from './token-reader';

/** Flags each subcommand accepts. Value flags take the next argument; `--config` is accepted everywhere. */
interface FlagSpec { values: string[]; booleans: string[] }

const SERVE_VALUES = ['--port', '--agents', '--allow', '--audience', '--public-key', '--oidc-issuer'];

export const COMMAND_FLAGS: Record<string, FlagSpec> = {
  'generate-keys': { values: ['--private-key', '--public-key'], booleans: [] },
  'decrypt-token': { values: ['--proxy-url', '--agent', '--audience', '--oidc-token-env', '--private-key'], booleans: [] },
  serve:           { values: SERVE_VALUES, booleans: [] },
  init:            { values: ['--allow', '--public-key', '--port', '--agents'], booleans: ['--force'] },
  config:          { values: [], booleans: [] },
  allow:           { values: ['--require'], booleans: ['--no-restart'] },
  mode:            { values: ['--public-key'], booleans: ['--no-restart'] },
  service:         { values: [], booleans: ['--force', '-f', '--follow'] },
  tunnel:          { values: ['--hostname', '--name', '--domain'], booleans: [] },
};

const isFlag = (arg: string): boolean => arg.startsWith('-') && arg.length > 1;

/**
 * Reject unknown flags and value flags without a value, and return the
 * positional arguments. A value that looks like a flag counts as missing, so
 * `--allow --port 7432` fails instead of treating `--port` as an allow entry.
 */
export function parseCommandArgs(command: string, args: string[]): string[] {
  const spec = COMMAND_FLAGS[command];
  const values = new Set(['--config', ...(spec?.values ?? [])]);
  const booleans = new Set(spec?.booleans ?? []);
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!isFlag(arg)) { positionals.push(arg); continue; }
    if (values.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || isFlag(value)) throw new Error(`${arg} needs a value`);
      i++;
    } else if (!booleans.has(arg)) {
      throw new Error(`Unknown option "${arg}" for "${command}". Run with --help for usage.`);
    }
  }
  return positionals;
}

export function getArg(args: string[], flag: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultValue;
  const value = args[idx + 1];
  if (value === undefined || isFlag(value)) throw new Error(`${flag} needs a value`);
  return value;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** All values of a repeatable flag; each value may also be comma-separated unless `split` is false. */
export function getArgs(args: string[], flag: string, split = true): string[] {
  const values: string[] = [];
  args.forEach((arg, idx) => {
    if (arg !== flag) return;
    const value = args[idx + 1];
    if (value === undefined || isFlag(value)) throw new Error(`${flag} needs a value`);
    values.push(...(split ? value.split(',') : [value]));
  });
  return values.map((v) => v.trim()).filter(Boolean);
}

/** `--port`: a whole number 1–65535 (no "7432abc"). */
export function parsePort(value: string): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid --port "${value}": expected a number from 1 to 65535`);
  return port;
}

/** `--agents claude,codex`: known agents, no empty entries, de-duplicated. */
export function parseAgents(value: string): Agent[] {
  const agents = value.split(',').map((a) => a.trim());
  if (agents.some((a) => !a)) throw new Error(`Invalid --agents "${value}": empty entry`);
  const unknown = agents.filter((a) => !AGENTS.includes(a as Agent));
  if (unknown.length) throw new Error(`Unknown agent(s) in --agents: ${unknown.join(', ')}. Supported: ${AGENTS.join(', ')}`);
  return [...new Set(agents as Agent[])];
}

/** `--hostname` / `--domain`: a bare host name like gw.example.com (no scheme, port or path). */
export function parseHostname(flag: string, value: string): string {
  const host = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;
  if (!host.test(value)) throw new Error(`Invalid ${flag} "${value}": expected a bare host name like gw.example.com (no https://, port or path)`);
  return value.toLowerCase();
}
