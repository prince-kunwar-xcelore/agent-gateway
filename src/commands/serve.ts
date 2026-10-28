import path from 'node:path';
import { getArg, getArgs } from '../args';
import { loadPem } from '../crypto';
import { startDaemon } from '../daemon';
import { startServer } from '../server';
import { DEFAULT_AUDIENCE, GITHUB_ISSUER, GITLAB_ISSUER } from '../oidc';
import { AGENTS, type Agent } from '../token-reader';

export function runServe(args: string[]): void {
  const port = parseInt(getArg(args, '--port', '7432')!, 10);

  const agents = (getArg(args, '--agents', AGENTS.join(','))!).split(',').map((a) => a.trim()) as Agent[];
  const unknown = agents.filter((a) => !AGENTS.includes(a));
  if (unknown.length) {
    console.error(`[startup] Unknown agent(s): ${unknown.join(', ')}. Supported: ${AGENTS.join(', ')}`);
    process.exit(1);
  }

  const allow = getArgs(args, '--allow');

  // Private-key mode: explicit --public-key, or ./public.pem when no allowlist is given
  // (preserves the original zero-flag behaviour).
  const explicitKey = getArg(args, '--public-key');
  const publicKeyPath = explicitKey ?? (allow.length ? null : 'public.pem');

  let publicKeyPem: string | null = null;
  if (publicKeyPath) {
    try {
      publicKeyPem = loadPem(path.resolve(publicKeyPath));
    } catch {
      console.error(`[startup] Failed to load public key from: ${path.resolve(publicKeyPath)}`);
      console.error('[startup] Run "generate-keys" to create a keypair, or use --allow <owner/repo> for OIDC mode.');
      process.exit(1);
    }
    console.log(`[startup] Private-key mode: ${path.resolve(publicKeyPath)}`);
  }

  const oidc = allow.length
    ? {
        allow,
        audience: getArg(args, '--audience', DEFAULT_AUDIENCE)!,
        issuers: [GITHUB_ISSUER, GITLAB_ISSUER, ...getArgs(args, '--oidc-issuer')],
      }
    : null;
  if (oidc) {
    console.log(`[startup] Allowlist mode: ${allow.join(', ')} (audience "${oidc.audience}")`);
    console.log(`[startup]   Trusted issuers: ${oidc.issuers.join(', ')}`);
  }

  console.log(`[startup] Starting on port ${port}...`);

  const stopDaemon = startDaemon(agents, publicKeyPem);
  const stopServer = startServer(port, { agents, keyMode: publicKeyPem !== null, oidc });

  const shutdown = (signal: string): void => {
    console.log(`\n[shutdown] ${signal} received. Shutting down...`);
    stopDaemon();
    stopServer();
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
