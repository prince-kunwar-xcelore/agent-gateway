import path from 'node:path';
import { getArg } from '../args';
import { loadPem } from '../crypto';
import { startDaemon } from '../daemon';
import { startServer } from '../server';

export function runServe(args: string[]): void {
  const publicKeyPath = path.resolve(getArg(args, '--public-key', 'public.pem')!);
  const port = parseInt(getArg(args, '--port', '7432')!, 10);

  let publicKeyPem: string;
  try {
    publicKeyPem = loadPem(publicKeyPath);
  } catch {
    console.error(`[startup] Failed to load public key from: ${publicKeyPath}`);
    console.error('[startup] Run "generate-keys" to create a keypair first.');
    process.exit(1);
  }

  console.log(`[startup] Public key: ${publicKeyPath}`);
  console.log(`[startup] Starting on port ${port}...`);

  const stopDaemon = startDaemon(publicKeyPem!);
  const stopServer = startServer(port);

  const shutdown = (signal: string): void => {
    console.log(`\n[shutdown] ${signal} received. Shutting down...`);
    stopDaemon();
    stopServer();
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
