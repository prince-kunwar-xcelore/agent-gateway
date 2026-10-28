import crypto from 'node:crypto';
import { promisify } from 'node:util';
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
  return process.env.AGENT_GATEWAY_PRIVATE_KEY || null;
}

export async function runDecryptToken(args: string[]): Promise<void> {
  const proxyUrl = getArg(args, '--proxy-url') || process.env.AGENT_GATEWAY_URL;
  if (!proxyUrl) fail('--proxy-url <url> or AGENT_GATEWAY_URL env var is required');

  const agent = getArg(args, '--agent', 'claude') as Agent;
  if (!AGENTS.includes(agent)) fail(`Unknown agent "${agent}". Supported: ${AGENTS.join(', ')}`);

  // Allowlist (OIDC) first; the private key is the fallback when OIDC is
  // unavailable here or the proxy refuses it (e.g. allowlist mode disabled).
  const privateKeyPem = resolvePrivateKey(args);
  const audience = getArg(args, '--audience', DEFAULT_AUDIENCE)!;
  const oidcEnv = getArg(args, '--oidc-token-env', 'AGENT_GATEWAY_OIDC_TOKEN')!;
  let token: string | null = null;

  try {
    const oidcToken = await getCiOidcToken(audience, oidcEnv);
    if (oidcToken) {
      const { privateKey, publicKey } = await promisify(crypto.generateKeyPair)('rsa', {
        modulusLength: 4096,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const encryptedToken = await fetchEncryptedTokenOidc(proxyUrl, agent, oidcToken, publicKey);
      token = decryptToken(encryptedToken, privateKey);
      process.stderr.write(`[token-proxy] Mode: OIDC allowlist (${agent})\n`);
    }
  } catch (err) {
    if (!privateKeyPem) throw err;
    process.stderr.write(`[token-proxy] OIDC allowlist failed (${err instanceof Error ? err.message : String(err)}); falling back to private key\n`);
  }

  if (token === null && privateKeyPem) {
    const encryptedToken = await fetchEncryptedToken(proxyUrl, agent);
    token = decryptToken(encryptedToken, privateKeyPem);
    process.stderr.write(`[token-proxy] Mode: private key (${agent})\n`);
  }

  if (token === null) {
    fail(
      'No credentials to authenticate with. Run in CI with OIDC (GitHub: `permissions: id-token: write`; ' +
      `GitLab: \`id_tokens: ${oidcEnv}: aud: ${audience}\`), or provide --private-key / AGENT_GATEWAY_PRIVATE_KEY.`,
    );
  }

  // Debug info on stderr so it doesn't pollute stdout (used by $() substitution)
  process.stderr.write(`[token-proxy] Decrypted token length: ${token.length}\n`);

  process.stdout.write(token);
}
