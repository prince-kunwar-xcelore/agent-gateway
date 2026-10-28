import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getArg } from '../args';
import { configPath, requireConfig, saveConfig, GATEWAY_DIR, type GatewayConfig } from '../config';
import { lingerHint, serviceManager, which, type ServiceSpec } from '../service';

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

function setupCloudflare(args: string[], config: GatewayConfig): { spec: ServiceSpec; hostname: string; tunnelName: string } {
  const hostname = getArg(args, '--hostname');
  if (!hostname) throw new Error('Usage: tunnel setup cloudflare --hostname <sub.your-domain.com> [--name <tunnel>]');
  const name = getArg(args, '--name', DEFAULT_TUNNEL_NAME)!;
  const cloudflared = requireBin('cloudflared', 'Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');

  if (!fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem'))) {
    throw new Error('Not logged in to Cloudflare. Run "cloudflared tunnel login" first.');
  }

  // Reuse an existing tunnel with this name, otherwise create it
  const findTunnel = (): { id: string; name: string } | undefined => {
    const list = exec(cloudflared, ['tunnel', 'list', '--output', 'json']);
    if (!list.ok) throw new Error(`cloudflared tunnel list failed: ${list.stderr}`);
    // cloudflared may print notices (e.g. update available) before the JSON
    const json = list.stdout.slice(Math.max(0, list.stdout.indexOf('[')));
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
  if (route.ok) console.log(`[tunnel] DNS: ${hostname} → ${name}`);
  else if (/already exists/i.test(route.stderr)) console.log(`[tunnel] DNS record for ${hostname} already exists — leaving it as is.`);
  else throw new Error(`cloudflared tunnel route dns failed: ${route.stderr}`);

  // Dedicated config so ~/.cloudflared/config.yml is left alone
  fs.mkdirSync(GATEWAY_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CLOUDFLARED_CONFIG, `tunnel: ${tunnel.id}
credentials-file: ${credentials}
ingress:
  - hostname: ${hostname}
    service: http://localhost:${config.port}
  - service: http_status:404
`);
  console.log(`[tunnel] Wrote ${CLOUDFLARED_CONFIG}`);

  return {
    hostname,
    tunnelName: name,
    spec: {
      name: TUNNEL_SERVICE,
      description: `Agent Gateway tunnel (Cloudflare → ${hostname})`,
      command: [cloudflared, 'tunnel', '--no-autoupdate', '--config', CLOUDFLARED_CONFIG, 'run', name],
    },
  };
}

// ── ngrok ────────────────────────────────────────────────────────────────────

function setupNgrok(args: string[], config: GatewayConfig): { spec: ServiceSpec; hostname: string } {
  const domain = getArg(args, '--domain');
  if (!domain) throw new Error('Usage: tunnel setup ngrok --domain <name.ngrok-free.app>');
  const ngrok = requireBin('ngrok', 'Install it: https://ngrok.com/download');

  // The service won't see shell env vars, so the authtoken must be in ngrok's config file
  const check = exec(ngrok, ['config', 'check']);
  const configFile = /at (\S+)/.exec(check.stdout + check.stderr)?.[1];
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

async function checkPublicHealth(hostname: string, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://${hostname}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function runTunnel(args: string[]): Promise<void> {
  const [action, provider] = args;
  const file = configPath(args);
  const manager = serviceManager();
  const stub: ServiceSpec = { name: TUNNEL_SERVICE, description: '', command: [] };

  switch (action) {
    case 'setup': {
      const config = requireConfig(file);
      let result: { spec: ServiceSpec; hostname: string; tunnelName?: string };
      if (provider === 'cloudflare') result = setupCloudflare(args, config);
      else if (provider === 'ngrok') result = setupNgrok(args, config);
      else throw new Error('Usage: tunnel setup cloudflare --hostname <host> | tunnel setup ngrok --domain <domain>');

      if (manager.state(stub).active) manager.stop(stub);
      manager.install(result.spec);
      manager.enable(result.spec);
      manager.start(result.spec);
      console.log(`[tunnel] Installed and started ${manager.unitPath(result.spec)}`);

      config.tunnel = { provider: provider as 'cloudflare' | 'ngrok', hostname: result.hostname, tunnelName: result.tunnelName };
      saveConfig(file, config);

      const url = `https://${result.hostname}`;
      console.log(`[tunnel] Public URL: ${url}  ← set this as the AGENT_GATEWAY_URL CI secret`);
      console.log(`[tunnel] ${(await checkPublicHealth(result.hostname)) ? `${url}/health is reachable.` : `${url}/health is not reachable yet — check "tunnel status" and that the proxy is running.`}`);
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
      const config = requireConfig(file);
      const state = manager.state(stub);
      console.log(`agent-gateway-tunnel (${manager.unitPath(stub)})`);
      console.log(`  service:    ${state.installed ? state.detail : 'not installed'}`);
      if (config.tunnel) {
        console.log(`  provider:   ${config.tunnel.provider}${config.tunnel.tunnelName ? ` (tunnel "${config.tunnel.tunnelName}")` : ''}`);
        console.log(`  public URL: https://${config.tunnel.hostname}`);
        console.log(`  health:     ${(await checkPublicHealth(config.tunnel.hostname, 1)) ? 'reachable' : 'UNREACHABLE'}`);
      }
      break;
    }

    case 'remove': {
      manager.uninstall(stub);
      const config = requireConfig(file);
      delete config.tunnel;
      saveConfig(file, config);
      console.log('[tunnel] Removed the tunnel service. Cloudflare tunnels and DNS records are left in place;');
      console.log('[tunnel]   delete them with "cloudflared tunnel delete <name>" if you no longer need them.');
      break;
    }

    default:
      throw new Error('Usage: tunnel setup cloudflare|ngrok ... | tunnel start|stop|status|remove');
  }
}
