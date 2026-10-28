import crypto from 'node:crypto';
import path from 'node:path';
import { getArg } from '../args';
import { loadPem, decryptToken } from '../crypto';
import { fetchEncryptedToken, fetchEncryptedTokenOidc, getCiOidcToken } from '../client';
import { DEFAULT_AUDIENCE } from '../oidc';
import { AGENTS, type Agent } from '../token-reader';

function fail(message: string): never {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function resolvePrivateKey(args: string[]): string | null {
  const privateKeyPath = getArg(args, '--private-key');
  if (privateKeyPath) {
    try {
      return loadPem(path.resolve(privateKeyPath));
    } catch {
      fail(`Could not read private key from: ${privateKeyPath}`);
    }
  }
  // `||` so an unset CI secret (expanded to "") falls through to OIDC mode
  return process.env.PROXY_PRIVATE_KEY || process.env.CLAUDE_PROXY_PRIVATE_KEY || null;
}

export async function runDecryptToken(args: string[]): Promise<void> {
  const proxyUrl = getArg(args, '--proxy-url') ?? process.env.PROXY_URL;
  if (!proxyUrl) fail('--proxy-url <url> or PROXY_URL env var is required');

  const agent = getArg(args, '--agent', 'claude') as Agent;
  if (!AGENTS.includes(agent)) fail(`Unknown agent "${agent}". Supported: ${AGENTS.join(', ')}`);

  let token: string;
  const privateKeyPem = resolvePrivateKey(args);

  if (privateKeyPem) {
    // Private-key mode
    const encryptedToken = await fetchEncryptedToken(proxyUrl, agent);
    token = decryptToken(encryptedToken, privateKeyPem);
    process.stderr.write(`[token-proxy] Mode: private key (${agent})\n`);
  } else {
    // Allowlist mode: identify via CI OIDC, receive credentials encrypted to a one-off key
    const audience = getArg(args, '--audience', DEFAULT_AUDIENCE)!;
    const oidcEnv = getArg(args, '--oidc-token-env', 'PROXY_OIDC_TOKEN')!;
    const oidcToken = await getCiOidcToken(audience, oidcEnv);
    if (!oidcToken) {
      fail(
        'No credentials to authenticate with. Provide --private-key / PROXY_PRIVATE_KEY, ' +
        'or run in CI with OIDC (GitHub: `permissions: id-token: write`; ' +
        `GitLab: \`id_tokens: ${oidcEnv}: aud: ${audience}\`).`,
      );
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const encryptedToken = await fetchEncryptedTokenOidc(proxyUrl, agent, oidcToken, publicKey);
    token = decryptToken(encryptedToken, privateKey);
    process.stderr.write(`[token-proxy] Mode: OIDC allowlist (${agent})\n`);
  }

  // Debug info on stderr so it doesn't pollute stdout (used by $() substitution)
  process.stderr.write(`[token-proxy] Decrypted token length: ${token.length}\n`);

  process.stdout.write(token);
}
