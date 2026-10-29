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
 *
 * An entry can be narrowed further with claim constraints (config
 * `allowlist.constraints`, keyed by entry): every listed claim must match one
 * of its patterns, where `*` matches any run of characters. E.g.
 *   { "github:owner/repo": { "event_name": ["pull_request"],
 *                            "job_workflow_ref": ["owner/repo/.github/workflows/pr-review.yml@*"] } }
 */

export type Platform = 'github' | 'gitlab';

/** Claims an entry may be constrained on, per platform. */
export const CONSTRAINT_CLAIMS: Record<Platform, string[]> = {
  github: ['ref', 'event_name', 'workflow_ref', 'job_workflow_ref', 'environment'],
  gitlab: ['ref', 'pipeline_source', 'ci_config_ref_uri'],
};

/** claim → accepted patterns */
export type Constraints = Record<string, string[]>;

export interface AllowEntry {
  /** Canonical form, e.g. "github:owner/*" */
  raw: string;
  platform: Platform;
  /** OIDC issuer URL the token must come from. */
  issuer: string;
  /** Lower-cased pattern: "owner/repo" or "owner/*". */
  pattern: string;
  /** Extra claims the token must match; none when absent. */
  constraints?: Constraints;
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
    // Normalising these away would silently trust an issuer that never matches `iss`
    if (url.search || url.hash || url.username || url.password) {
      throw new Error(`Invalid allow entry "${entry}": issuer URL must not have credentials, a query or a fragment`);
    }
    // `gitlab@https://host:8443/*` (pattern forgotten) would otherwise trust https://host for group "8443"
    // A slash before the colon (gitlab@https://host/:123/*) makes a numeric group unambiguous
    if (/^\d+(\/|$)/.test(rest.slice(idx + 1)) && !rest.slice(0, idx).endsWith('/')) {
      throw new Error(
        `Invalid allow entry "${entry}": "${rest.slice(idx + 1)}" looks like a port. ` +
        'Use gitlab@https://host:port:group/*, or gitlab@https://host/:group/* for a numeric group',
      );
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
  // Keep the slash before a numeric group so the canonical form re-parses the same way
  const selfHosted = `gitlab@${issuer}${/^\d/.test(pattern) ? '/' : ''}`;
  const prefix = platform === 'github' ? 'github' : issuer === GITLAB_ISSUER ? 'gitlab' : selfHosted;
  return { raw: `${prefix}:${pattern}`, platform, issuer, pattern };
}

/** Check a constraints object for an entry: known claims, non-empty string patterns. Returns it canonicalised. */
export function parseConstraints(entry: AllowEntry, constraints: unknown): Constraints {
  if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) {
    throw new Error(`Constraints for "${entry.raw}" must be an object of claim → pattern(s)`);
  }
  const allowed = CONSTRAINT_CLAIMS[entry.platform];
  const parsed: Constraints = {};
  for (const [claim, value] of Object.entries(constraints)) {
    if (!allowed.includes(claim)) {
      throw new Error(`Unknown claim "${claim}" in constraints for "${entry.raw}". ${entry.platform === 'github' ? 'GitHub' : 'GitLab'} claims: ${allowed.join(', ')}`);
    }
    const patterns = Array.isArray(value) ? value : [value];
    if (!patterns.length || !patterns.every((p) => typeof p === 'string' && p)) {
      throw new Error(`Constraint "${claim}" for "${entry.raw}" needs one or more non-empty string patterns`);
    }
    parsed[claim] = patterns as string[];
  }
  return parsed;
}

/**
 * Parse, canonicalise and de-duplicate entries, attaching their constraints
 * (keyed by entry, in any accepted spelling). Throws on the first invalid one,
 * and on constraints for an entry that isn't in the list.
 */
export function parseAllowList(entries: string[], constraints: Record<string, unknown> = {}): AllowEntry[] {
  const seen = new Map<string, AllowEntry>();
  for (const entry of entries) {
    const parsed = parseAllowEntry(entry);
    if (!seen.has(parsed.raw)) seen.set(parsed.raw, parsed);
  }
  for (const [key, value] of Object.entries(constraints)) {
    const entry = seen.get(parseAllowEntry(key).raw);
    if (!entry) throw new Error(`Constraints given for "${key}", which is not in the allowlist`);
    entry.constraints = parseConstraints(entry, value);
  }
  return [...seen.values()];
}

export const formatConstraints = (constraints: Constraints): string =>
  Object.entries(constraints).map(([claim, patterns]) => `${claim}=${patterns.join(',')}`).join('; ');

/** `--require claim=pattern[,pattern]` values → constraints (validated later against the entry's platform). */
export function parseRequireFlags(values: string[]): Constraints {
  const constraints: Constraints = {};
  for (const value of values) {
    const eq = value.indexOf('=');
    const claim = value.slice(0, eq).trim();
    const patterns = value.slice(eq + 1).split(',').map((p) => p.trim()).filter(Boolean);
    if (eq <= 0 || !patterns.length) throw new Error(`Invalid --require "${value}": expected claim=pattern[,pattern]`);
    constraints[claim] = [...(constraints[claim] ?? []), ...patterns];
  }
  return constraints;
}

/** `*` matches any run of characters (including `/`); everything else is literal. */
export function globMatches(value: string, pattern: string): boolean {
  const regex = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${regex}$`).test(value);
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
export function entryAllows(entry: AllowEntry, issuer: string, claims: Record<string, unknown>): boolean {
  if (entry.issuer !== issuer.replace(/\/$/, '')) return false;
  const repo = entry.platform === 'github' ? claims.repository : claims.project_path;
  if (typeof repo !== 'string' || !patternMatches(repo, entry.pattern)) return false;
  // A constrained claim missing from the token never matches
  return Object.entries(entry.constraints ?? {}).every(([claim, patterns]) => {
    const value = claims[claim];
    return typeof value === 'string' && patterns.some((p) => globMatches(value, p));
  });
}
