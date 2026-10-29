#!/usr/bin/env node
import { runGenerateKeys } from './commands/generate-keys';
import { runDecryptToken }  from './commands/decrypt-token';
import { runServe }         from './commands/serve';
import { runInit, runConfig, runAllow, runMode } from './commands/config';
import { runService }       from './commands/service';
import { runTunnel }        from './commands/tunnel';
import { COMMAND_FLAGS, parseCommandArgs } from './args';

const [subcommand, ...args] = process.argv.slice(2);

const HELP = `
agent-gateway — serves your local Claude / Codex subscription credentials, encrypted, over HTTP

Usage:
  agent-gateway <subcommand> [options]

Setup:
  init                          Write ~/.agent-gateway/config.json
    --allow <entry>               Enable allowlist mode with this entry (repeatable / comma-separated)
    --public-key <path>           Enable private-key mode with this public key
    --port <number>               HTTP port            (default: 7432)
    --agents <list>               claude,codex         (default: both)
    --force                       Overwrite an existing config

  service install [--force]     Run as a user service (systemd / launchd), start now and on boot
  service uninstall | start | stop | restart | enable | disable
  service status                Service state + /health summary
  service logs [-f]

  tunnel setup cloudflare --hostname <host> [--name <tunnel>]
                                Expose via Cloudflare Tunnel (reuses a tunnel with that name)
  tunnel setup ngrok --domain <domain>
                                Expose via ngrok (free plan: your one static ngrok domain)
  tunnel start | stop | status | remove

Config (changes restart a running service; --no-restart to skip):
  config show | path
  allow add <entry...> [--require <claim>=<pattern>[,<pattern>]]...
  allow remove <entry...> | allow list
                                Entries:
                                  owner/repo, owner/*                    GitHub (same as github:owner/*)
                                  gitlab:group/project, gitlab:group/*   gitlab.com
                                  gitlab@https://host:group/*            self-hosted GitLab
                                Only issuers named by an entry are trusted.
                                --require narrows the entries to tokens whose claim matches
                                (* = any characters), e.g. event_name=pull_request.
                                GitHub claims: ref, event_name, workflow_ref, job_workflow_ref, environment
                                GitLab claims: ref, pipeline_source, ci_config_ref_uri
  mode enable|disable private-key|allowlist [--public-key <path>]
  mode status

Run:
  serve                         Start the proxy in the foreground
    --config <path>               Config file          (default: ~/.agent-gateway/config.json)
    Flags override the config file field by field:
    --port, --agents, --allow, --audience <aud>, --public-key <path>
    With no config file and no --allow, private-key mode uses ./public.pem.

CI side:
  decrypt-token                 Fetch + decrypt credentials from a running proxy
    --proxy-url <url>             Proxy URL            (or AGENT_GATEWAY_URL env var)
    --agent <claude|codex>        Credentials to fetch (default: claude)
    Tries CI OIDC (allowlist mode) first:
    --audience <aud>              OIDC audience        (default: agent-gateway)
    --oidc-token-env <name>       Env var holding an OIDC token (default: AGENT_GATEWAY_OIDC_TOKEN);
                                  falls back to the GitHub Actions OIDC request API
    Falls back to private-key mode when OIDC is unavailable or refused:
    --private-key <path>          RSA private key PEM  (or AGENT_GATEWAY_PRIVATE_KEY env var)

  generate-keys                 Generate a new RSA-4096 keypair (private-key mode)
    --private-key <path>          Output path          (default: private.pem)
    --public-key  <path>          Output path          (default: public.pem)

All commands accept --config <path>.
`;

async function main(): Promise<void> {
  if (subcommand && subcommand in COMMAND_FLAGS) parseCommandArgs(subcommand, args);

  switch (subcommand) {
    case 'generate-keys': runGenerateKeys(args); break;
    case 'decrypt-token': await runDecryptToken(args); break;
    case 'serve':         runServe(args); break;
    case 'init':          runInit(args); break;
    case 'config':        runConfig(args); break;
    case 'allow':         runAllow(args); break;
    case 'mode':          runMode(args); break;
    case 'service':       await runService(args); break;
    case 'tunnel':        await runTunnel(args); break;

    case undefined:
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      throw new Error(`Unknown subcommand "${subcommand}". Run with --help for usage.`);
  }
}

await main().catch((err: unknown) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
