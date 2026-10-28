import { GITHUB_ISSUER, GITLAB_ISSUER } from './issuers';

/**
 * Allowlist entries bind a repo pattern to the CI platform that may claim it:
 *
 *   owner/repo, owner/*                      GitHub Actions (bare = GitHub)
 *   github:owner/repo                        GitHub Actions
 *   gitlab:group/project, gitlab:group/*     gitlab.com (subgroups: group/sub/project)
 *   gitlab@https://git.example.com:group/*   self-hosted GitLab
 *
 * Without the binding, `owner/*` would also match a gitlab.com namespace that
 * anyone could register under the same name.
 */

export type Platform = 'github' | 'gitlab';

export interface AllowEntry {
  /** Canonical form, e.g. "github:owner/*" */
  raw: string;
  platform: Platform;
  /** OIDC issuer URL the token must come from. */
  issuer: string;
  /** Lower-cased pattern: "owner/repo" or "owner/*". */
  pattern: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function validatePattern(pattern: string, platform: Platform, entry: string): string {
  const segments = pattern.split('/');
  const wildcard = segments.at(-1) === '*';
  const names = wildcard ? segments.slice(0, -1) : segments;

  const minNames = wildcard ? 1 : 2;
  const maxNames = platform === 'github' ? (wildcard ? 1 : 2) : Infinity;
  if (names.length < minNames || names.length > maxNames || !names.every((s) => SEGMENT.test(s))) {
    const shape = platform === 'github' ? 'owner/repo or owner/*' : 'group[/subgroup]/project or group/*';
    throw new Error(`Invalid allow entry "${entry}": expected ${shape}`);
  }
  return pattern.toLowerCase();
}

export function parseAllowEntry(entry: string): AllowEntry {
  const trimmed = entry.trim();
  let platform: Platform;
  let issuer: string;
  let pattern: string;

  if (trimmed.startsWith('gitlab@')) {
    // gitlab@<issuer URL>:<pattern> — split on the last colon, URLs contain colons too
    const rest = trimmed.slice('gitlab@'.length);
    const idx = rest.lastIndexOf(':');
    if (idx <= 0) throw new Error(`Invalid allow entry "${entry}": expected gitlab@https://host:group/*`);
    let url: URL;
    try {
      url = new URL(rest.slice(0, idx));
      if (url.protocol !== 'https:') throw new Error();
    } catch {
      throw new Error(`Invalid allow entry "${entry}": issuer must be an https URL`);
    }
    // Normalise (lower-case host, default port dropped, no trailing slash) so it compares
    // equal to the token's `iss`
    issuer = `${url.origin}${url.pathname}`.replace(/\/$/, '');
    platform = 'gitlab';
    pattern = rest.slice(idx + 1);
  } else if (trimmed.startsWith('gitlab:')) {
    platform = 'gitlab';
    issuer = GITLAB_ISSUER;
    pattern = trimmed.slice('gitlab:'.length);
  } else {
    platform = 'github';
    issuer = GITHUB_ISSUER;
    pattern = trimmed.startsWith('github:') ? trimmed.slice('github:'.length) : trimmed;
  }

  pattern = validatePattern(pattern, platform, entry);
  const prefix = platform === 'github' ? 'github' : issuer === GITLAB_ISSUER ? 'gitlab' : `gitlab@${issuer}`;
  return { raw: `${prefix}:${pattern}`, platform, issuer, pattern };
}

/** Parse, canonicalise and de-duplicate entries. Throws on the first invalid one. */
export function parseAllowList(entries: string[]): AllowEntry[] {
  const seen = new Map<string, AllowEntry>();
  for (const entry of entries) {
    const parsed = parseAllowEntry(entry);
    if (!seen.has(parsed.raw)) seen.set(parsed.raw, parsed);
  }
  return [...seen.values()];
}

/** Issuers the proxy should trust: exactly those named by at least one entry. */
export function trustedIssuers(allow: AllowEntry[]): string[] {
  return [...new Set(allow.map((e) => e.issuer))];
}

export function patternMatches(repo: string, pattern: string): boolean {
  const lower = repo.toLowerCase();
  if (!pattern.endsWith('/*')) return lower === pattern;
  const prefix = pattern.slice(0, -1);
  // `owner/*` needs something after the slash: `owner/` alone is not a repo
  return lower.length > prefix.length && lower.startsWith(prefix);
}

/**
 * Does a verified token's identity match an entry? The issuer must match the
 * entry's, and the repo comes from the claim that issuer's platform uses.
 */
export function entryAllows(entry: AllowEntry, issuer: string, claims: { repository?: string; project_path?: string }): boolean {
  if (entry.issuer !== issuer.replace(/\/$/, '')) return false;
  const repo = entry.platform === 'github' ? claims.repository : claims.project_path;
  return typeof repo === 'string' && patternMatches(repo, entry.pattern);
}
