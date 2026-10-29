import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getArg, parseHostname } from '../args';
import { configPath, loadConfig, requireConfig, saveConfig, GATEWAY_DIR, type GatewayConfig, type TunnelConfig } from '../config';
import { lingerHint, serviceManager, which, type ServiceManager, type ServiceSpec } from '../service';
import { fetchHealth, type Health } from './service';

/**
 * Optional helpers to expose the proxy publicly. The proxy itself is
 * tunnel-agnostic; these only create a second user service that runs
 * cloudflared or ngrok in front of localhost:<port>.
 */

export const TUNNEL_SERVICE = 'agent-gateway-tunnel';
const CLOUDFLARED_CONFIG = path.join(GATEWAY_DIR, 'cloudflared.yml');
const DEFAULT_TUNNEL_NAME = 'agent-gateway';

function exec(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout?.trim() ?? '', stderr: r.stderr?.trim() ?? '' };
}

function requireBin(bin: string, install: string): string {
  const found = which(bin);
  if (!found) throw new Error(`${bin} not found on PATH. ${install}`);
  return found;
}

// ── Cloudflare ───────────────────────────────────────────────────────────────

interface TunnelSetup {
  spec: ServiceSpec;
  hostname: string;
  tunnelName?: string;
  /** The DNS record existed before setup, so it may point at another tunnel. */
  dnsPreexisting?: boolean;
}

function setupCloudflare(args: string[], config: GatewayConfig): TunnelSetup {
  const hostnameArg = getArg(args, '--hostname');
  if (!hostnameArg) throw new Error('Usage: tunnel setup cloudflare --hostname <sub.your-domain.com> [--name <tunnel>]');
  const hostname = parseHostname('--hostname', hostnameArg);
  const name = getArg(args, '--name', DEFAULT_TUNNEL_NAME)!;
  const cloudflared = requireBin('cloudflared', 'Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');

  if (!fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem'))) {
    throw new Error('Not logged in to Cloudflare. Run "cloudflared tunnel login" first.');
  }

  // Reuse an existing tunnel with this name, otherwise create it
  const findTunnel = (): { id: string; name: string } | undefined => {
    const list = exec(cloudflared, ['tunnel', 'list', '--output', 'json']);
    if (!list.ok) throw new Error(`cloudflared tunnel list failed: ${list.stderr}`);
    // cloudflared may print notices (e.g. "[WARNING] …") before the JSON array, which
    // starts with `[` followed by `{` or `]` at the start of a line
    const start = /^\[\s*[{\]]/m.exec(list.stdout)?.index ?? 0;
    const json = list.stdout.slice(start);
    try {
      return (JSON.parse(json || '[]') as { id: string; name: string }[]).find((t) => t.name === name);
    } catch {
      throw new Error(`Could not parse "cloudflared tunnel list" output:\n${list.stdout.slice(0, 300)}`);
    }
  };
  let tunnel = findTunnel();
  if (tunnel) {
    console.log(`[tunnel] Reusing Cloudflare tunnel "${name}" (${tunnel.id})`);
  } else {
    const created = exec(cloudflared, ['tunnel', 'create', name]);
    if (!created.ok) throw new Error(`cloudflared tunnel create failed: ${created.stderr}`);
    tunnel = findTunnel();
    if (!tunnel) throw new Error(`Tunnel "${name}" was created but is not listed`);
    console.log(`[tunnel] Created Cloudflare tunnel "${name}" (${tunnel.id})`);
  }

  const credentials = path.join(os.homedir(), '.cloudflared', `${tunnel.id}.json`);
  if (!fs.existsSync(credentials)) {
    throw new Error(`Tunnel credentials not found at ${credentials}. They are only written on the machine that created the tunnel.`);
  }

  const route = exec(cloudflared, ['tunnel', 'route', 'dns', name, hostname]);
  // An existing record may target a different tunnel; it's checked through /health once the tunnel is up
  const dnsPreexisting = !route.ok && /already exists/i.test(route.stderr);
  if (route.ok) console.log(`[tunnel] DNS: ${hostname} → ${name}`);
  else if (dnsPreexisting) console.log(`[tunnel] DNS record for ${hostname} already exists — will check that it reaches this proxy.`);
  else throw new Error(`cloudflared tunnel route dns failed: ${route.stderr}`);

  // Dedicated config so ~/.cloudflared/config.yml is left alone
  fs.mkdirSync(GATEWAY_DIR, { recursive: true, mode: 0o700 });
  // JSON strings are valid YAML scalars, so values are quoted safely
  const q = JSON.stringify;
  fs.writeFileSync(CLOUDFLARED_CONFIG, `tunnel: ${q(tunnel.id)}
credentials-file: ${q(credentials)}
ingress:
  - hostname: ${q(hostname)}
    service: ${q(`http://localhost:${config.port}`)}
  - service: http_status:404
`, { mode: 0o600 });
  fs.chmodSync(CLOUDFLARED_CONFIG, 0o600);
  console.log(`[tunnel] Wrote ${CLOUDFLARED_CONFIG}`);

  return {
    hostname,
    tunnelName: name,
    dnsPreexisting,
    spec: {
      name: TUNNEL_SERVICE,
      description: `Agent Gateway tunnel (Cloudflare → ${hostname})`,
      command: [cloudflared, 'tunnel', '--no-autoupdate', '--config', CLOUDFLARED_CONFIG, 'run', name],
    },
  };
}

// ── ngrok ────────────────────────────────────────────────────────────────────

function setupNgrok(args: string[], config: GatewayConfig): TunnelSetup {
  const domainArg = getArg(args, '--domain');
  if (!domainArg) throw new Error('Usage: tunnel setup ngrok --domain <name.ngrok-free.app>');
  const domain = parseHostname('--domain', domainArg);
  const ngrok = requireBin('ngrok', 'Install it: https://ngrok.com/download');

  // The service won't see shell env vars, so the authtoken must be in ngrok's config file
  const check = exec(ngrok, ['config', 'check']);
  // "Valid configuration file at /path/ngrok.yml" — the path may contain spaces
  const configFile = /configuration file at (.+?)\s*$/m.exec(check.stdout + '\n' + check.stderr)?.[1];
  const hasToken = configFile && fs.existsSync(configFile) && /authtoken:/.test(fs.readFileSync(configFile, 'utf8'));
  if (!hasToken) {
    throw new Error('No ngrok authtoken in its config file. Run "ngrok config add-authtoken <token>" (an env var alone is not visible to the service).');
  }

  return {
    hostname: domain,
    spec: {
      name: TUNNEL_SERVICE,
      description: `Agent Gateway tunnel (ngrok → ${domain})`,
      command: [ngrok, 'http', String(config.port), `--url=${domain}`, '--log=stdout'],
    },
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────

export type PublicHealth = 'this-proxy' | 'other' | 'reachable' | 'unreachable';

/**
 * Does https://<hostname>/health answer, and is it this proxy? Compared by
 * the per-process instance_id, when the local proxy is running to compare
 * with. 'other' means something else answers there, e.g. a DNS record that
 * points at a different tunnel.
 */
export async function checkPublicHealth(
  hostname: string,
  local: Health | null,
  attempts = 10,
  delayMs = 2000,
): Promise<PublicHealth> {
  let result: PublicHealth = 'unreachable';
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, delayMs));
    let res: Response;
    try {
      res = await fetch(`https://${hostname}/health`, { signal: AbortSignal.timeout(5000) });
    } catch { continue; /* not up yet */ }
    // Cloudflare answers 5xx (e.g. 530) while the tunnel is still connecting
    if (res.status >= 500) continue;
    const remote = (await res.json().catch(() => null)) as Health | null;
    if (!local?.instance_id) {
      if (remote?.instance_id || remote?.modes) return 'reachable';
      result = 'other';
      continue;
    }
    if (remote?.instance_id === local.instance_id) return 'this-proxy';
    result = 'other';
  }
  return result;
}

/**
 * Install and start the tunnel service, then record it in the config. If
 * anything fails the unit is removed again (and a tunnel entry whose service
 * was replaced is dropped), so the config and the installed service never
 * disagree.
 */
export async function installTunnel(
  manager: ServiceManager,
  setup: TunnelSetup,
  entry: TunnelConfig,
  file: string,
  config: GatewayConfig,
  verify: () => Promise<void>,
): Promise<void> {
  const stub: ServiceSpec = { name: TUNNEL_SERVICE, description: '', command: [] };
  if (manager.state(stub).active) manager.stop(stub);
  try {
    manager.install(setup.spec);
    manager.enable(setup.spec);
    manager.start(setup.spec);
    await verify();
  } catch (err) {
    try { manager.uninstall(setup.spec); } catch { /* best effort */ }
    if (config.tunnel) { delete config.tunnel; saveConfig(file, config); }
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n[tunnel] Rolled back: the tunnel service was removed.`);
  }
  config.tunnel = entry;
  saveConfig(file, config);
}

export async function runTunnel(args: string[]): Promise<void> {
  const [action, provider] = args;
  const file = configPath(args);
  const manager = serviceManager();
  const stub: ServiceSpec = { name: TUNNEL_SERVICE, description: '', command: [] };

  switch (action) {
    case 'setup': {
      const config = requireConfig(file);
      let result: TunnelSetup;
      if (provider === 'cloudflare') result = setupCloudflare(args, config);
      else if (provider === 'ngrok') result = setupNgrok(args, config);
      else throw new Error('Usage: tunnel setup cloudflare --hostname <host> | tunnel setup ngrok --domain <domain>');

      const url = `https://${result.hostname}`;
      const entry: TunnelConfig = { provider, hostname: result.hostname, tunnelName: result.tunnelName };
      await installTunnel(manager, result, entry, file, config, async () => {
        console.log(`[tunnel] Installed and started ${manager.unitPath(result.spec)}; checking ${url}/health…`);
        const local = await fetchHealth(config.port);
        const reach = await checkPublicHealth(result.hostname, local);
        if (reach === 'other') {
          throw new Error(
            `${url}/health is answered by something other than this proxy.` +
            (result.dnsPreexisting
              ? ` The existing DNS record for ${result.hostname} probably points at another tunnel: delete it in the Cloudflare dashboard (or use another --hostname) and run setup again.`
              : ' Check where the hostname points.'),
          );
        }
        console.log(`[tunnel] ${
          reach === 'this-proxy' ? `${url}/health reaches this proxy.`
          : reach === 'reachable' ? `${url}/health is reachable (start the proxy service to confirm it is this one).`
          : `${url}/health is not reachable yet — check "tunnel status" and that the proxy is running.`
        }`);
      });
      console.log(`[tunnel] Public URL: ${url}  ← set this as the AGENT_GATEWAY_URL CI secret`);
      const hint = lingerHint();
      if (hint) console.log(`[tunnel] ${hint}`);
      break;
    }

    case 'start':
    case 'stop':
      if (!manager.state(stub).installed) throw new Error('No tunnel service. Run "tunnel setup" first.');
      manager[action](stub);
      console.log(`[tunnel] ${action === 'start' ? 'Started' : 'Stopped'}.`);
      break;

    case 'status': {
      // Tolerate a missing config: the service may still be installed
      const config = loadConfig(file);
      const state = manager.state(stub);
      console.log(`agent-gateway-tunnel (${manager.unitPath(stub)})`);
      console.log(`  service:    ${state.installed ? state.detail : 'not installed'}`);
      if (config?.tunnel) {
        const reach = await checkPublicHealth(config.tunnel.hostname, await fetchHealth(config.port), 1);
        console.log(`  provider:   ${config.tunnel.provider}${config.tunnel.tunnelName ? ` (tunnel "${config.tunnel.tunnelName}")` : ''}`);
        console.log(`  public URL: https://${config.tunnel.hostname}`);
        console.log(`  health:     ${{ 'this-proxy': 'reaches this proxy', reachable: 'reachable', other: 'ANSWERED BY SOMETHING ELSE', unreachable: 'UNREACHABLE' }[reach]}`);
      }
      break;
    }

    case 'remove': {
      // Tolerate a missing config so an orphaned service can still be removed
      const config = loadConfig(file);
      if (!manager.state(stub).installed && !config?.tunnel) throw new Error('No tunnel service is installed.');
      manager.uninstall(stub);
      if (config?.tunnel) {
        delete config.tunnel;
        saveConfig(file, config);
      }
      console.log('[tunnel] Removed the tunnel service. Cloudflare tunnels and DNS records are left in place;');
      console.log('[tunnel]   delete them with "cloudflared tunnel delete <name>" if you no longer need them.');
      break;
    }

    default:
      throw new Error('Usage: tunnel setup cloudflare|ngrok ... | tunnel start|stop|status|remove');
  }
}
