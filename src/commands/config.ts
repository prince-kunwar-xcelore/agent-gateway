import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getArg, getArgs, hasFlag, parseAgents, parseCommandArgs, parsePort } from '../args';
import { formatConstraints, parseAllowList, parseConstraints, parseRequireFlags } from '../allowlist';
import {
  configPath, defaultConfig, loadConfig, requireConfig, saveConfig, validateConfig,
  type GatewayConfig,
} from '../config';
import { restartIfRunning } from './service';

function printConfig(file: string, config: GatewayConfig): void {
  console.log(`# ${file}`);
  console.log(JSON.stringify(config, null, 2));
}

/** Resolve a --public-key path and check it is the RSA-4096 public key the encryption layout expects. */
function checkPublicKey(file: string): string {
  const abs = path.resolve(file);
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(`${missing ? 'Public key not found' : 'Not a PEM public key'}: ${abs}. Create one with "generate-keys".`);
  }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 4096) {
    throw new Error(`${abs} is not an RSA-4096 public key. Create one with "generate-keys".`);
  }
  return abs;
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
  const port = getArg(args, '--port');
  if (port) config.port = parsePort(port);
  const agents = getArg(args, '--agents');
  if (agents) config.agents = parseAgents(agents);

  const allow = getArgs(args, '--allow');
  if (allow.length) {
    config.allowlist.enabled = true;
    config.allowlist.allow = parseAllowList(allow).map((e) => e.raw);
  }
  const publicKey = getArg(args, '--public-key');
  if (publicKey) config.privateKey = { enabled: true, publicKeyPath: checkPublicKey(publicKey) };
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
  const [action, ...patterns] = parseCommandArgs('allow', args);
  const file = configPath(args);
  const config = requireConfig(file);

  if (action === 'list') {
    const entries = parseAllowList(config.allowlist.allow, config.allowlist.constraints);
    if (!entries.length) console.log('(empty)');
    for (const e of entries) console.log(e.constraints ? `${e.raw}  (requires ${formatConstraints(e.constraints)})` : e.raw);
    if (!config.allowlist.enabled) console.log('[allow] Note: allowlist mode is disabled ("mode enable allowlist").');
    return;
  }
  if ((action !== 'add' && action !== 'remove') || !patterns.length) {
    throw new Error('Usage: allow add <entry...> [--require claim=pattern ...] | allow remove <entry...> | allow list');
  }
  const required = getArgs(args, '--require', false);
  if (required.length && action !== 'add') throw new Error('--require only applies to "allow add"');

  const current = parseAllowList(config.allowlist.allow, config.allowlist.constraints);
  const changed = parseAllowList(patterns);

  // parseAllowList canonicalises and de-duplicates, so entries compare by `raw`
  const currentRaw = new Set(current.map((e) => e.raw));
  // Re-key constraints by canonical entry so removals and replacements find them
  const constraints = Object.fromEntries(current.filter((e) => e.constraints).map((e) => [e.raw, e.constraints!]));
  if (action === 'add') {
    const added = changed.filter((e) => !currentRaw.has(e.raw)).map((e) => e.raw);
    if (!added.length && !required.length) { console.log('[allow] Nothing to add (already allowed).'); return; }
    if (required.length) {
      // Replaces any constraints the entries had; validated against each entry's platform
      const requested = parseRequireFlags(required);
      for (const e of changed) constraints[e.raw] = parseConstraints(e, requested);
    }
    config.allowlist.allow = [...currentRaw, ...added];
    if (added.length) console.log(`[allow] Added: ${added.join(', ')}`);
    if (required.length) console.log(`[allow] Constraints for ${changed.map((e) => e.raw).join(', ')}: ${formatConstraints(constraints[changed[0].raw])}`);
  } else {
    const removed = changed.filter((e) => currentRaw.has(e.raw)).map((e) => e.raw);
    const missing = changed.filter((e) => !currentRaw.has(e.raw)).map((e) => e.raw);
    if (missing.length) console.warn(`[allow] Not in allowlist: ${missing.join(', ')}`);
    if (!removed.length) return;
    config.allowlist.allow = [...currentRaw].filter((raw) => !removed.includes(raw));
    for (const raw of removed) delete constraints[raw];
    console.log(`[allow] Removed: ${removed.join(', ')}`);
    if (config.allowlist.enabled && !config.allowlist.allow.length) {
      console.warn('[allow] Allowlist is now empty — every OIDC request will be rejected.');
    }
  }

  if (Object.keys(constraints).length) config.allowlist.constraints = constraints;
  else delete config.allowlist.constraints;
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
    if (publicKey && !enable) throw new Error('--public-key only applies to "mode enable private-key"');
    if (enable) {
      const keyPath = publicKey ?? config.privateKey.publicKeyPath;
      if (!keyPath) throw new Error('Public key not set. Create one with "generate-keys", then pass --public-key <path>.');
      config.privateKey.publicKeyPath = checkPublicKey(keyPath);
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
