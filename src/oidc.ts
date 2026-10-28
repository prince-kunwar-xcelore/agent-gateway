import crypto from 'node:crypto';

/**
 * Minimal OIDC ID-token verification for CI identity tokens
 * (GitHub Actions, GitLab CI). RS256 only — both platforms sign with it.
 *
 * Flow: decode header → fetch issuer's JWKS via OpenID discovery →
 * verify signature → check iss / aud / exp / nbf → return claims.
 */

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITLAB_ISSUER = 'https://gitlab.com';
export const DEFAULT_AUDIENCE = 'agent-gateway';

const JWKS_TTL_MS = 60 * 60 * 1000;
// Unknown kids force a refetch (key rotation); cap that so forged kids can't make us hammer the issuer
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

export interface OidcClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  sub: string;
  /** GitHub: "owner/repo" */
  repository?: string;
  /** GitLab: "group/project" */
  project_path?: string;
  [claim: string]: unknown;
}

export interface OidcOptions {
  issuers: string[];
  audience: string;
  /** Repo patterns: "owner/repo" or "owner/*". */
  allow: string[];
}

type Jwk = crypto.JsonWebKey & { kid?: string };
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

function b64urlJson<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

async function getJwks(issuer: string, forceRefresh = false): Promise<Jwk[]> {
  const cached = jwksCache.get(issuer);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && (forceRefresh ? age < JWKS_MIN_REFRESH_MS : age < JWKS_TTL_MS)) return cached.keys;

  const config = await fetchJson<{ jwks_uri: string }>(
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  );
  const { keys } = await fetchJson<{ keys: Jwk[] }>(config.jwks_uri);
  jwksCache.set(issuer, { keys, fetchedAt: Date.now() });
  return keys;
}

/** Repo identity from the token: GitHub `repository`, GitLab `project_path`. */
export function repoFromClaims(claims: OidcClaims): string | null {
  return claims.repository ?? claims.project_path ?? null;
}

export function repoAllowed(repo: string, allow: string[]): boolean {
  const lower = repo.toLowerCase();
  return allow.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.endsWith('/*') ? lower.startsWith(p.slice(0, -1)) : lower === p;
  });
}

/**
 * Verify an OIDC ID token and return its claims if it was issued by a trusted
 * issuer, for our audience, to an allowlisted repo. Throws otherwise.
 */
export async function verifyOidcToken(jwt: string, opts: OidcOptions): Promise<OidcClaims> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = b64urlJson<{ alg: string; kid?: string }>(headerB64);
  if (header.alg !== 'RS256') throw new Error(`Unsupported JWT alg: ${header.alg}`);
  // Without a kid, find() would match any JWKS entry that also lacks one
  if (!header.kid) throw new Error('JWT header has no kid');

  // Trust the issuer only after checking it against our list — it selects the JWKS.
  const unverified = b64urlJson<OidcClaims>(payloadB64);
  if (!unverified || typeof unverified !== 'object' || typeof unverified.iss !== 'string') {
    throw new Error('JWT payload has no issuer');
  }
  const issuer = opts.issuers.find((i) => i.replace(/\/$/, '') === unverified.iss.replace(/\/$/, ''));
  if (!issuer) throw new Error(`Untrusted issuer: ${unverified.iss}`);

  let keys = await getJwks(issuer);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Issuer may have rotated keys since we cached them
    keys = await getJwks(issuer, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error(`No JWKS key matches kid ${header.kid}`);

  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signatureB64, 'base64url'),
  );
  if (!valid) throw new Error('Invalid JWT signature');

  const claims = unverified;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw new Error('Token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) throw new Error('Token not yet valid');

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(opts.audience)) throw new Error(`Audience mismatch: expected ${opts.audience}`);

  const repo = repoFromClaims(claims);
  if (!repo) throw new Error('Token has no repository / project_path claim');
  if (!repoAllowed(repo, opts.allow)) throw new Error(`Repository not allowlisted: ${repo}`);

  return claims;
}
