import fs from 'node:fs';
import path from 'node:path';
import { getArg, getArgs, hasFlag } from '../args';
import { parseAllowList } from '../allowlist';
import {
  configPath, defaultConfig, loadConfig, requireConfig, saveConfig, validateConfig,
  DEFAULT_PORT, type GatewayConfig,
} from '../config';
import type { Agent } from '../token-reader';
import { restartIfRunning } from './service';

function printConfig(file: string, config: GatewayConfig): void {
  console.log(`# ${file}`);
  console.log(JSON.stringify(config, null, 2));
}

function saveValid(file: string, config: GatewayConfig): void {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join('\n'));
  saveConfig(file, config);
}

/** `init` — write config.json from flags. */
export function runInit(args: string[]): void {
  const file = configPath(args);
  if (loadConfig(file) && !hasFlag(args, '--force')) {
    throw new Error(`${file} already exists. Use --force to overwrite.`);
  }

  const config = defaultConfig();
  config.port = parseInt(getArg(args, '--port', String(DEFAULT_PORT))!, 10);
  const agents = getArg(args, '--agents');
  if (agents) config.agents = agents.split(',').map((a) => a.trim()) as Agent[];

  const allow = getArgs(args, '--allow');
  if (allow.length) {
    config.allowlist.enabled = true;
    config.allowlist.allow = parseAllowList(allow).map((e) => e.raw);
  }
  const publicKey = getArg(args, '--public-key');
  if (publicKey) {
    const abs = path.resolve(publicKey);
    if (!fs.existsSync(abs)) throw new Error(`Public key not found: ${abs}. Create one with "generate-keys".`);
    config.privateKey = { enabled: true, publicKeyPath: abs };
  }
  if (!allow.length && !publicKey) {
    throw new Error('Choose at least one auth mode: --allow <owner/repo|owner/*> and/or --public-key <path>');
  }

  saveValid(file, config);
  printConfig(file, config);
  console.log('\nNext steps:');
  console.log('  service install                          run it as a background service (starts on boot)');
  console.log('  tunnel setup cloudflare --hostname <h>   optional: expose it publicly');
  console.log('  Then set the AGENT_GATEWAY_URL CI secret to the public URL.');
}

/** `config show|path` */
export function runConfig(args: string[]): void {
  const [action] = args;
  const file = configPath(args);
  if (action === 'path') {
    console.log(file);
  } else if (action === 'show') {
    printConfig(file, requireConfig(file));
  } else {
    throw new Error('Usage: config show|path [--config <path>]');
  }
}

/** `allow add|remove|list` */
export function runAllow(args: string[]): void {
  const [action, ...rest] = args;
  const file = configPath(args);
  const config = requireConfig(file);
  // Positional patterns: everything that isn't a flag or a flag's value
  const patterns = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--config');

  if (action === 'list') {
    if (!config.allowlist.allow.length) console.log('(empty)');
    for (const entry of config.allowlist.allow) console.log(entry);
    if (!config.allowlist.enabled) console.log('[allow] Note: allowlist mode is disabled ("mode enable allowlist").');
    return;
  }
  if ((action !== 'add' && action !== 'remove') || !patterns.length) {
    throw new Error('Usage: allow add|remove <entry...> | allow list');
  }

  const current = parseAllowList(config.allowlist.allow);
  const changed = parseAllowList(patterns);

  if (action === 'add') {
    const added = changed.filter((e) => !current.some((c) => c.raw === e.raw));
    config.allowlist.allow = [...current, ...added].map((e) => e.raw);
    if (!added.length) { console.log('[allow] Nothing to add (already allowed).'); return; }
    console.log(`[allow] Added: ${added.map((e) => e.raw).join(', ')}`);
  } else {
    const removing = new Set(changed.map((e) => e.raw));
    const missing = changed.filter((e) => !current.some((c) => c.raw === e.raw));
    if (missing.length) console.warn(`[allow] Not in allowlist: ${missing.map((e) => e.raw).join(', ')}`);
    config.allowlist.allow = current.filter((e) => !removing.has(e.raw)).map((e) => e.raw);
    if (missing.length === changed.length) return;
    console.log(`[allow] Removed: ${changed.filter((e) => !missing.includes(e)).map((e) => e.raw).join(', ')}`);
    if (config.allowlist.enabled && !config.allowlist.allow.length) {
      console.warn('[allow] Allowlist is now empty — every OIDC request will be rejected.');
    }
  }

  saveValid(file, config);
  if (!config.allowlist.enabled) console.log('[allow] Note: allowlist mode is disabled ("mode enable allowlist").');
  restartIfRunning(args);
}

/** `mode enable|disable private-key|allowlist`, `mode status` */
export function runMode(args: string[]): void {
  const [action, mode] = args;
  const file = configPath(args);
  const config = requireConfig(file);

  if (action === 'status') {
    console.log(`private-key: ${config.privateKey.enabled ? 'enabled' : 'disabled'}${config.privateKey.publicKeyPath ? ` (${config.privateKey.publicKeyPath})` : ''}`);
    console.log(`allowlist:   ${config.allowlist.enabled ? 'enabled' : 'disabled'} (${config.allowlist.allow.join(', ') || 'empty'})`);
    return;
  }
  if ((action !== 'enable' && action !== 'disable') || (mode !== 'private-key' && mode !== 'allowlist')) {
    throw new Error('Usage: mode enable|disable private-key|allowlist | mode status');
  }

  const enable = action === 'enable';
  if (mode === 'private-key') {
    const publicKey = getArg(args, '--public-key');
    if (publicKey) config.privateKey.publicKeyPath = path.resolve(publicKey);
    if (enable) {
      const keyPath = config.privateKey.publicKeyPath;
      if (!keyPath || !fs.existsSync(keyPath)) {
        throw new Error(`Public key ${keyPath ? `not found: ${keyPath}` : 'not set'}. Create one with "generate-keys", then pass --public-key <path>.`);
      }
    }
    config.privateKey.enabled = enable;
  } else {
    config.allowlist.enabled = enable;
    if (enable && !config.allowlist.allow.length) {
      console.warn('[mode] Allowlist is empty — add repos with "allow add <owner/*>".');
    }
  }

  if (!config.privateKey.enabled && !config.allowlist.enabled) {
    throw new Error(`Refusing to disable ${mode}: both modes would be off. Enable the other mode first.`);
  }
  saveValid(file, config);
  console.log(`[mode] ${mode} ${enable ? 'enabled' : 'disabled'}.`);
  restartIfRunning(args);
}
