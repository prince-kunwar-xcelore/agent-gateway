import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { hasFlag } from '../args';
import { configPath, requireConfig, validateConfig, type GatewayConfig } from '../config';
import { lingerHint, serviceManager, which, type ServiceSpec } from '../service';

export const PROXY_SERVICE = 'agent-gateway';

/**
 * Absolute runtime + entry point for the service to run. Node can't execute
 * the .ts sources directly, so under tsx we use Bun if available, otherwise
 * the tsup build in dist/.
 */
export function resolveEntrypoint(): string[] {
  const entry = fs.realpathSync(path.resolve(process.argv[1]));
  if (!entry.endsWith('.ts') || process.versions.bun) return [process.execPath, entry];

  const bun = which('bun');
  if (bun) return [bun, entry];

  const dist = path.resolve(path.dirname(entry), '..', 'dist', 'index.js');
  if (fs.existsSync(dist)) return [process.execPath, dist];
  throw new Error('Running from TypeScript source without Bun. Run "pnpm build" first so the service can use dist/index.js.');
}

export function proxySpec(file: string): ServiceSpec {
  return {
    name: PROXY_SERVICE,
    description: 'Agent Gateway — serves local agent subscription credentials',
    command: [...resolveEntrypoint(), 'serve', '--config', file],
  };
}

/** Is something accepting connections on localhost:<port>? */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

/**
 * After a config change: restart the proxy service if it is running so the
 * change takes effect. `--no-restart` skips it.
 */
export function restartIfRunning(args: string[]): void {
  if (hasFlag(args, '--no-restart')) {
    console.log('[service] --no-restart: change applies on next start.');
    return;
  }
  let manager;
  try { manager = serviceManager(); } catch { return; }

  const spec = { name: PROXY_SERVICE, description: '', command: [] };
  if (!manager.state(spec).active) {
    console.log('[service] Service not running: change applies on next start.');
    return;
  }
  manager.restart(spec);
  console.log('[service] Restarted agent-gateway to apply the change.');
}

interface Health {
  ok: boolean;
  modes: { private_key: boolean; allowlist: boolean };
  agents: Record<string, { ok: boolean; age_seconds: number | null; last_error: string | null }>;
}

export async function fetchHealth(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

export function printHealth(health: Health | null, config: GatewayConfig): void {
  if (!health) {
    console.log(`  health:     unreachable on http://localhost:${config.port}/health`);
    return;
  }
  const modes = [health.modes.private_key && 'private-key', health.modes.allowlist && 'allowlist'].filter(Boolean);
  console.log(`  health:     ${health.ok ? 'ok' : 'DEGRADED'}`);
  console.log(`  modes:      ${modes.join(', ') || '(none)'}`);
  if (health.modes.allowlist) console.log(`  allowlist:  ${config.allowlist.allow.join(', ') || '(empty)'}`);
  for (const [agent, s] of Object.entries(health.agents)) {
    const age = s.age_seconds === null ? 'never refreshed' : `refreshed ${s.age_seconds}s ago`;
    console.log(`  ${agent.padEnd(10)}  ${s.ok ? 'ok' : 'FAIL'}, ${age}${s.last_error ? ` — ${s.last_error}` : ''}`);
  }
}

export async function runService(args: string[]): Promise<void> {
  const [action] = args;
  const file = configPath(args);
  const manager = serviceManager();
  const stub: ServiceSpec = { name: PROXY_SERVICE, description: '', command: [] };

  switch (action) {
    case 'install': {
      const config = requireConfig(file);
      const errors = validateConfig(config);
      if (errors.length) throw new Error(`Config is invalid:\n  ${errors.join('\n  ')}`);

      const state = manager.state(stub);
      if (state.installed && !hasFlag(args, '--force')) {
        throw new Error(`Already installed at ${manager.unitPath(stub)}. Use --force to reinstall.`);
      }
      if (state.active) manager.stop(stub);

      const spec = proxySpec(file);
      manager.install(spec);
      manager.enable(spec);
      console.log(`[service] Installed ${manager.unitPath(spec)}`);
      console.log(`[service]   ${spec.command.join(' ')}`);

      if (await portInUse(config.port)) {
        console.warn(`[service] Port ${config.port} is already in use (a manually started proxy?). Stop it, then run "service start".`);
      } else {
        manager.start(spec);
        console.log('[service] Started and enabled on boot.');
      }
      const hint = lingerHint();
      if (hint) console.log(`[service] ${hint}`);
      break;
    }

    case 'uninstall':
      manager.uninstall(stub);
      console.log(`[service] Uninstalled ${manager.unitPath(stub)}`);
      break;

    case 'start':
    case 'stop':
    case 'restart': {
      if (!manager.state(stub).installed) throw new Error('Service is not installed. Run "service install".');
      if (action !== 'stop' && !manager.state(stub).active && (await portInUse(requireConfig(file).port))) {
        throw new Error(`Port ${requireConfig(file).port} is already in use (a manually started proxy?). Stop it first.`);
      }
      manager[action](stub);
      console.log(`[service] ${action === 'stop' ? 'Stopped' : action === 'start' ? 'Started' : 'Restarted'}.`);
      break;
    }

    case 'enable':
    case 'disable': {
      manager[action](stub);
      console.log(`[service] ${action === 'enable' ? 'Will' : 'Will not'} start on boot.`);
      const hint = action === 'enable' ? lingerHint() : null;
      if (hint) console.log(`[service] ${hint}`);
      break;
    }

    case 'status': {
      const config = requireConfig(file);
      const state = manager.state(stub);
      console.log(`agent-gateway (${manager.unitPath(stub)})`);
      console.log(`  service:    ${state.installed ? state.detail : 'not installed'}`);
      console.log(`  config:     ${file}`);
      printHealth(await fetchHealth(config.port), config);
      if (!state.active && (await portInUse(config.port))) {
        console.log(`  note:       port ${config.port} is served by something other than the service`);
      }
      break;
    }

    case 'logs':
      manager.logs(stub, hasFlag(args, '-f') || hasFlag(args, '--follow'));
      break;

    default:
      throw new Error('Usage: service install|uninstall|start|stop|restart|enable|disable|status|logs [-f]');
  }
}
