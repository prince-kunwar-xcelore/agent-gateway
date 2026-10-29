import { getArgs } from '../args';
import { loadPem } from '../crypto';
import { startDaemon } from '../daemon';
import { startServer } from '../server';
import { formatConstraints, parseAllowList, trustedIssuers } from '../allowlist';
import { resolveServeConfig, validateConfig } from '../config';

export function runServe(args: string[]): void {
  if (getArgs(args, '--oidc-issuer').length) {
    console.error('[startup] --oidc-issuer was removed: name the issuer in the allow entry instead,');
    console.error('[startup]   e.g. --allow gitlab@https://git.example.com:group/*  (gitlab.com: --allow gitlab:group/*)');
    process.exit(1);
  }

  let resolved: ReturnType<typeof resolveServeConfig>;
  try {
    resolved = resolveServeConfig(args);
  } catch (err) {
    console.error(`[startup] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const { config, source } = resolved;

  const errors = validateConfig(config);
  if (errors.length) {
    for (const e of errors) console.error(`[startup] ${e}`);
    process.exit(1);
  }
  console.log(`[startup] Config: ${source ?? '(none — flags only)'}`);

  let publicKeyPem: string | null = null;
  if (config.privateKey.enabled) {
    const publicKeyPath = config.privateKey.publicKeyPath!;
    try {
      publicKeyPem = loadPem(publicKeyPath);
    } catch {
      console.error(`[startup] Failed to load public key from: ${publicKeyPath}`);
      console.error('[startup] Run "generate-keys" to create a keypair, or use allowlist mode (--allow <owner/repo>).');
      process.exit(1);
    }
    console.log(`[startup] Private-key mode: ${publicKeyPath}`);
  }

  const allow = parseAllowList(config.allowlist.allow, config.allowlist.constraints);
  const oidc = config.allowlist.enabled ? { allow, audience: config.allowlist.audience } : null;
  if (oidc) {
    if (!allow.length) console.warn('[startup] Allowlist mode is enabled but the allowlist is empty — every OIDC request will be rejected.');
    console.log(`[startup] Allowlist mode: ${allow.map((e) => e.raw).join(', ') || '(empty)'} (audience "${oidc.audience}")`);
    console.log(`[startup]   Trusted issuers: ${trustedIssuers(allow).join(', ') || '(none)'}`);
    for (const e of allow.filter((e) => e.constraints)) console.log(`[startup]   ${e.raw} requires ${formatConstraints(e.constraints!)}`);
  }

  console.log(`[startup] Starting on port ${config.port}...`);

  const stopDaemon = startDaemon(config.agents, publicKeyPem);
  const stopServer = startServer(config.port, { agents: config.agents, keyMode: publicKeyPem !== null, oidc });

  const shutdown = (signal: string): void => {
    console.log(`\n[shutdown] ${signal} received. Shutting down...`);
    stopDaemon();
    stopServer();
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
