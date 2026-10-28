#!/usr/bin/env node
import { hasFlag } from './args';
import { runGenerateKeys } from './commands/generate-keys';
import { runDecryptToken }  from './commands/decrypt-token';
import { runServe }         from './commands/serve';

const [subcommand, ...args] = process.argv.slice(2);

switch (subcommand) {
  case 'generate-keys':
    runGenerateKeys(args);
    break;

  case 'decrypt-token':
    await runDecryptToken(args).catch((err: unknown) => {
      process.stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
    break;

  case 'serve':
    runServe(args);
    break;

  case undefined:
  case '--help':
  case '-h':
    console.log(`
claude-token-proxy — serves your local Claude / Codex subscription credentials, encrypted, over HTTP

Usage:
  claude-token-proxy <subcommand> [options]

Subcommands:
  serve                         Start the proxy daemon + HTTP server
    --agents <list>               Agents to serve: claude,codex    (default: claude,codex)
    --port <number>               HTTP port                        (default: 7432)
    Private-key mode (GET /token):
    --public-key <path>           RSA public key PEM               (default: public.pem if no --allow)
    Allowlist mode (POST /token with a CI OIDC token):
    --allow <entry>               Allowed repo (repeatable or comma-separated):
                                    owner/repo, owner/*            GitHub (same as github:owner/*)
                                    gitlab:group/project, gitlab:group/*   gitlab.com
                                    gitlab@https://host:group/*    self-hosted GitLab
                                  Only issuers named by an entry are trusted.
    --audience <aud>              Expected OIDC audience           (default: agent-gateway)
    Both modes can be enabled together.

  decrypt-token                 Fetch + decrypt credentials from a running proxy
    --proxy-url <url>             Proxy URL            (or AGENT_GATEWAY_URL env var)
    --agent <claude|codex>        Credentials to fetch (default: claude)
    Tries CI OIDC (allowlist mode) first; a private key is the fallback:
    --private-key <path>          RSA private key PEM  (or AGENT_GATEWAY_PRIVATE_KEY env var)
    --audience <aud>              OIDC audience        (default: agent-gateway)
    --oidc-token-env <name>       Env var holding an OIDC token (default: AGENT_GATEWAY_OIDC_TOKEN);
                                  falls back to the GitHub Actions OIDC request API

  generate-keys                 Generate a new RSA-4096 keypair
    --private-key <path>          Output path          (default: private.pem)
    --public-key  <path>          Output path          (default: public.pem)
`);
    break;

  default:
    process.stderr.write(`ERROR: Unknown subcommand "${subcommand}". Run with --help for usage.\n`);
    process.exit(1);
}
