import type { Agent } from './token-reader';

const TIMEOUT_MS = 10_000;

function tokenUrl(proxyUrl: string, agent: Agent): string {
  const url = new URL('/token', proxyUrl);
  url.searchParams.set('agent', agent);
  return url.toString();
}

async function readTokenResponse(res: Response, url: string): Promise<string> {
  const body = (await res.text()).trim();
  if (!res.ok) throw new Error(`Proxy returned HTTP ${res.status} from ${url}: ${body}`);
  return body;
}

/**
 * Private-key mode: fetch credentials encrypted with the proxy's configured
 * public key. Returns the base64-encoded encrypted token.
 */
export async function fetchEncryptedToken(proxyUrl: string, agent: Agent): Promise<string> {
  const url = tokenUrl(proxyUrl, agent);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return readTokenResponse(res, url);
}

/**
 * Allowlist mode: prove CI identity with an OIDC token and have the proxy
 * encrypt credentials with a one-off public key. Returns the base64-encoded
 * encrypted token.
 */
export async function fetchEncryptedTokenOidc(
  proxyUrl: string,
  agent: Agent,
  oidcToken: string,
  publicKeyPem: string,
): Promise<string> {
  const url = tokenUrl(proxyUrl, agent);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${oidcToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: publicKeyPem }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return readTokenResponse(res, url);
}

/**
 * Obtain a CI OIDC token for the given audience.
 *   - explicit env var (GitLab `id_tokens:` or any CI that injects one)
 *   - GitHub Actions runtime request (needs `permissions: id-token: write`)
 * Returns null when not running in a CI that can provide one.
 */
export async function getCiOidcToken(audience: string, envVar: string): Promise<string | null> {
  if (process.env[envVar]) return process.env[envVar]!;

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;

  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${res.status}`);
  const { value } = (await res.json()) as { value?: unknown };
  if (typeof value !== 'string' || !value) throw new Error('GitHub OIDC token response has no token value');
  return value;
}
