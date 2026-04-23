import path from 'node:path';
import { getArg } from '../args';
import { loadPem, decryptToken } from '../crypto';
import { fetchEncryptedToken } from '../client';

export async function runDecryptToken(args: string[]): Promise<void> {
  const proxyUrl = getArg(args, '--proxy-url') ?? process.env.PROXY_URL;
  if (!proxyUrl) {
    process.stderr.write('ERROR: --proxy-url <url> or PROXY_URL env var is required\n');
    process.exit(1);
  }

  let privateKeyPem: string;
  const privateKeyPath = getArg(args, '--private-key');
  if (privateKeyPath) {
    try {
      privateKeyPem = loadPem(path.resolve(privateKeyPath));
    } catch {
      process.stderr.write(`ERROR: Could not read private key from: ${privateKeyPath}\n`);
      process.exit(1);
    }
  } else if (process.env.CLAUDE_PROXY_PRIVATE_KEY) {
    privateKeyPem = process.env.CLAUDE_PROXY_PRIVATE_KEY;
  } else {
    process.stderr.write('ERROR: --private-key <path> or CLAUDE_PROXY_PRIVATE_KEY env var is required\n');
    process.exit(1);
  }

  const encryptedToken = await fetchEncryptedToken(proxyUrl);
  const token = decryptToken(encryptedToken, privateKeyPem!);

  // Debug info on stderr so it doesn't pollute stdout (used by $() substitution)
  process.stderr.write(`[token-proxy] Decrypted token length: ${token.length}\n`);
  process.stderr.write(`[token-proxy] Token preview: ${token.slice(0, 30)}…\n`);

  process.stdout.write(token);
}
