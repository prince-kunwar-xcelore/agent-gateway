import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getArg, getArgs } from './args';
import { parseAllowList } from './allowlist';
import { DEFAULT_AUDIENCE } from './oidc';
import { AGENTS, type Agent } from './token-reader';

/**
 * Persistent configuration at ~/.agent-gateway/config.json.
 * `serve` reads it; init / allow / mode / tunnel commands write it.
 * Paths are stored absolute because the service runs from another directory.
 */

export const GATEWAY_DIR = path.join(os.homedir(), '.agent-gateway');
export const DEFAULT_CONFIG_PATH = path.join(GATEWAY_DIR, 'config.json');
export const DEFAULT_PORT = 7432;

export interface TunnelConfig {
  provider: 'cloudflare' | 'ngrok';
  /** Public hostname, e.g. gateway.example.com or name.ngrok-free.app */
  hostname: string;
  /** Cloudflare tunnel name (cloudflare only) */
  tunnelName?: string;
}

export interface GatewayConfig {
  port: number;
  agents: Agent[];
  privateKey: { enabled: boolean; publicKeyPath: string | null };
  allowlist: { enabled: boolean; allow: string[]; audience: string };
  tunnel?: TunnelConfig;
}

export function defaultConfig(): GatewayConfig {
  return {
    port: DEFAULT_PORT,
    agents: [...AGENTS],
    privateKey: { enabled: false, publicKeyPath: null },
    allowlist: { enabled: false, allow: [], audience: DEFAULT_AUDIENCE },
  };
}

export function configPath(args: string[]): string {
  return path.resolve(getArg(args, '--config', DEFAULT_CONFIG_PATH)!);
}

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Load the config file, or null if it does not exist. Missing fields fall back to defaults. */
export function loadConfig(file: string): GatewayConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: Partial<GatewayConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<GatewayConfig>;
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...parsed,
    // Keep non-object values as-is so validateConfig can report them
    privateKey: isObject(parsed.privateKey) ? { ...defaults.privateKey, ...parsed.privateKey } : parsed.privateKey === undefined ? defaults.privateKey : parsed.privateKey,
    allowlist: isObject(parsed.allowlist) ? { ...defaults.allowlist, ...parsed.allowlist } : parsed.allowlist === undefined ? defaults.allowlist : parsed.allowlist,
  };
}

/** Load the config file or exit with a pointer to `init`. */
export function requireConfig(file: string): GatewayConfig {
  const config = loadConfig(file);
  if (!config) {
    console.error(`[config] No config at ${file}. Run "init" first.`);
    process.exit(1);
  }
  return config;
}

export function saveConfig(file: string, config: GatewayConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Problems that make a config unusable. Empty when valid. */
export function validateConfig(config: GatewayConfig): string[] {
  // Hand-edited files can have the wrong types; check shape before using the values
  const shapeErrors: string[] = [];
  if (!Array.isArray(config.agents)) shapeErrors.push('"agents" must be an array');
  if (!config.privateKey || typeof config.privateKey !== 'object') shapeErrors.push('"privateKey" must be an object');
  if (!config.allowlist || typeof config.allowlist !== 'object') shapeErrors.push('"allowlist" must be an object');
  else if (!Array.isArray(config.allowlist.allow)) shapeErrors.push('"allowlist.allow" must be an array');
  if (shapeErrors.length) return shapeErrors;

  const errors: string[] = [];
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) errors.push(`Invalid port: ${config.port}`);

  const unknown = config.agents.filter((a) => !AGENTS.includes(a));
  if (unknown.length) errors.push(`Unknown agent(s): ${unknown.join(', ')}. Supported: ${AGENTS.join(', ')}`);
  if (!config.agents.length) errors.push('No agents configured');

  if (!config.privateKey.enabled && !config.allowlist.enabled) {
    errors.push('Both auth modes are disabled; enable private-key or allowlist');
  }
  if (config.privateKey.enabled && !config.privateKey.publicKeyPath) {
    errors.push('Private-key mode is enabled but no publicKeyPath is set');
  }
  try {
    parseAllowList(config.allowlist.allow);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return errors;
}

/**
 * Effective serve settings: the config file (if any) with CLI flags overriding
 * it field by field. With no config file and no mode flags, private-key mode
 * uses ./public.pem — the original zero-flag behaviour.
 */
export function resolveServeConfig(args: string[]): { config: GatewayConfig; source: string | null } {
  const file = configPath(args);
  const fromFile = loadConfig(file);
  const config = fromFile ?? defaultConfig();

  const port = getArg(args, '--port');
  if (port) config.port = parseInt(port, 10);

  const agents = getArg(args, '--agents');
  if (agents) config.agents = agents.split(',').map((a) => a.trim()) as Agent[];

  const allow = getArgs(args, '--allow');
  if (allow.length) config.allowlist = { ...config.allowlist, enabled: true, allow };

  const audience = getArg(args, '--audience');
  if (audience) config.allowlist.audience = audience;

  const publicKey = getArg(args, '--public-key');
  if (publicKey) {
    config.privateKey = { enabled: true, publicKeyPath: path.resolve(publicKey) };
  } else if (!fromFile && !allow.length) {
    config.privateKey = { enabled: true, publicKeyPath: path.resolve('public.pem') };
  }

  return { config, source: fromFile ? file : null };
}
