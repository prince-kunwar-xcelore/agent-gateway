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
    await runDecryptToken(args);
    break;

  case 'serve':
    runServe(args);
    break;

  case undefined:
  case '--help':
  case '-h':
    console.log(`
claude-token-proxy — serves an encrypted Claude.ai session token over HTTP

Usage:
  claude-token-proxy <subcommand> [options]

Subcommands:
  serve                         Start the proxy daemon + HTTP server
    --public-key <path>           RSA public key PEM   (default: public.pem)
    --port <number>               HTTP port            (default: 7432)

  decrypt-token                 Fetch + decrypt the token from a running proxy
    --proxy-url <url>             Proxy URL            (or PROXY_URL env var)
    --private-key <path>          RSA private key PEM  (or CLAUDE_PROXY_PRIVATE_KEY env var)

  generate-keys                 Generate a new RSA-4096 keypair
    --private-key <path>          Output path          (default: private.pem)
    --public-key  <path>          Output path          (default: public.pem)
`);
    break;

  default:
    process.stderr.write(`ERROR: Unknown subcommand "${subcommand}". Run with --help for usage.\n`);
    process.exit(1);
}
