import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Read a credentials file and check it has an access token. Returns the raw
 * JSON, or the reason the file can't be used (shown when every source fails).
 */
function readCredentialsFile(file: string, hasToken: (parsed: any) => boolean): { raw: string } | { reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { reason: code === 'ENOENT' ? 'not found' : `unreadable (${code ?? (err as Error).message})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: 'invalid JSON' };
  }
  return parsed && typeof parsed === 'object' && hasToken(parsed) ? { raw } : { reason: 'no access token in it' };
}

const describe = (skipped: [string, string][]): string => skipped.map(([file, reason]) => `${file}: ${reason}`).join('; ');

/**
 * Read the full Claude credentials JSON from disk.
 * The Claude CLI requires the complete credentials object (accessToken,
 * expiresAt, scopes, etc.) — returning just the access token is not enough.
 *
 * Checks ~/.claude/.credentials.json first (current Claude Code format),
 * then falls back to ~/.claude/auth.json (older versions). Throws with the
 * reason each file was skipped.
 */
function readCredentialsFromDisk(): string {
  const sources: [string, (parsed: any) => boolean][] = [
    [path.join(os.homedir(), '.claude', '.credentials.json'), (p) => Boolean(p.claudeAiOauth?.accessToken)],
    [path.join(os.homedir(), '.claude', 'auth.json'), (p) => Boolean(p.access_token ?? p.accessToken)],
  ];
  const skipped: [string, string][] = [];
  for (const [file, hasToken] of sources) {
    const result = readCredentialsFile(file, hasToken);
    if ('raw' in result) return result.raw;
    skipped.push([file, result.reason]);
  }
  throw new Error(describe(skipped));
}

/**
 * Try to read the full credentials from the system keychain.
 *
 * If a keychain entry exists, it contains only the access token (bare string),
 * so we wrap it in the credentials envelope the CLI expects. The token will
 * work for the current session but won't include refresh/scopes metadata.
 * Returns the reason instead when keytar is unavailable or the key is not found.
 */
async function readCredentialsFromKeychain(): Promise<{ raw: string } | { reason: string }> {
  try {
    const keytar = await import('keytar');
    const token = await keytar.default.getPassword('claude-code', 'oauth-token');
    if (!token) return { reason: 'no entry' };
    // Wrap bare token in the minimal structure the CLI needs
    return {
      raw: JSON.stringify({
        claudeAiOauth: {
          accessToken: token,
          expiresAt: Date.now() + 24 * 3600 * 1000,
        },
      }),
    };
  } catch (err) {
    return { reason: `unavailable (${err instanceof Error ? err.message : String(err)})` };
  }
}

export type Agent = 'claude' | 'codex';
export const AGENTS: Agent[] = ['claude', 'codex'];

/**
 * Read the full Codex auth.json from $CODEX_HOME (default ~/.codex).
 * Contains the ChatGPT subscription tokens (or an OPENAI_API_KEY) that
 * `codex exec` needs.
 */
function readCodexCredentials(): string {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const authPath = path.join(codexHome, 'auth.json');

  const result = readCredentialsFile(authPath, (p) => Boolean(p.tokens?.access_token || p.OPENAI_API_KEY));
  if ('raw' in result) return result.raw;
  throw new Error(
    `Could not read Codex credentials (${describe([[authPath, result.reason]])}). ` +
    'Make sure Codex CLI is installed and you are logged in.'
  );
}

/** Read the current credentials JSON string for the given agent. */
export async function readCredentials(agent: Agent): Promise<string> {
  return agent === 'codex' ? readCodexCredentials() : readToken();
}

/**
 * Read the current Claude credentials JSON string.
 * Priority: disk file → system keychain.
 *
 * Disk is preferred because it contains the full credentials object
 * (accessToken, refreshToken, expiresAt, scopes, etc.) that the CLI expects.
 */
export async function readToken(): Promise<string> {
  // Prefer disk — it has the full credentials structure
  let diskError: string;
  try {
    return readCredentialsFromDisk();
  } catch (err) {
    diskError = err instanceof Error ? err.message : String(err);
  }

  const keychain = await readCredentialsFromKeychain();
  if ('raw' in keychain) return keychain.raw;

  throw new Error(
    `Could not read Claude credentials (${diskError}; keychain: ${keychain.reason}). ` +
    'Make sure Claude Code is installed and you are logged in.'
  );
}

/** Access-token expiry in ms since the epoch, or null when unknown (API keys, legacy formats). */
export function credentialsExpiry(agent: Agent, raw: string): number | null {
  try {
    const parsed = JSON.parse(raw);
    if (agent === 'claude') {
      const expiresAt = parsed?.claudeAiOauth?.expiresAt;
      return typeof expiresAt === 'number' ? expiresAt : null;
    }
    const jwt = parsed?.tokens?.access_token;
    if (typeof jwt !== 'string') return null;
    const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Copy of the credentials that CI can use but not refresh. Both providers
 * rotate refresh tokens on use, so a CI refresh would log out the local CLI.
 *   Claude: refreshToken is removed (the CLI uses the access token as is;
 *           also refresh_token in the legacy auth.json format).
 *   Codex:  refresh_token is blanked (the CLI rejects auth.json without the
 *           field) and last_refresh set to now so it doesn't try to refresh.
 */
export function withoutRefreshToken(agent: Agent, raw: string): string {
  const parsed = JSON.parse(raw);
  if (agent === 'claude') {
    const oauth = parsed?.claudeAiOauth ?? parsed;
    delete oauth.refreshToken;
    delete oauth.refreshTokenExpiresAt;
    delete oauth.refresh_token;
  } else {
    if (!parsed?.tokens) return raw;
    parsed.tokens.refresh_token = '';
    parsed.last_refresh = new Date().toISOString();
  }
  return JSON.stringify(parsed);
}
