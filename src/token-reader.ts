import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Read the full Claude credentials JSON from disk.
 * The Claude CLI requires the complete credentials object (accessToken,
 * expiresAt, scopes, etc.) — returning just the access token is not enough.
 *
 * Checks ~/.claude/.credentials.json first (current Claude Code format),
 * then falls back to ~/.claude/auth.json (older versions).
 */
function readCredentialsFromDisk(): string {
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const authPath = path.join(os.homedir(), '.claude', 'auth.json');

  if (fs.existsSync(credentialsPath)) {
    try {
      const raw = fs.readFileSync(credentialsPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        claudeAiOauth?: { accessToken?: string };
      };
      if (parsed?.claudeAiOauth?.accessToken) return raw;
    } catch { /* fall through */ }
  }

  if (fs.existsSync(authPath)) {
    try {
      const raw = fs.readFileSync(authPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        access_token?: string;
        accessToken?: string;
      };
      const token = parsed?.access_token ?? parsed?.accessToken;
      if (token) return raw;
    } catch { /* fall through */ }
  }

  throw new Error(
    `Could not read Claude credentials. Checked: ${credentialsPath}, ${authPath}. ` +
    'Make sure Claude Code is installed and you are logged in.'
  );
}

/**
 * Try to read the full credentials from the system keychain.
 *
 * If a keychain entry exists, it contains only the access token (bare string),
 * so we wrap it in the credentials envelope the CLI expects. The token will
 * work for the current session but won't include refresh/scopes metadata.
 * Returns null if keytar is unavailable or the key is not found.
 */
async function readCredentialsFromKeychain(): Promise<string | null> {
  try {
    const keytar = await import('keytar');
    const token = await keytar.default.getPassword('claude-code', 'oauth-token');
    if (!token) return null;
    // Wrap bare token in the minimal structure the CLI needs
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        expiresAt: Date.now() + 24 * 3600 * 1000,
      },
    });
  } catch {
    return null;
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

  try {
    const raw = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: string };
      OPENAI_API_KEY?: string | null;
    };
    if (parsed?.tokens?.access_token || parsed?.OPENAI_API_KEY) return raw;
  } catch { /* fall through */ }

  throw new Error(
    `Could not read Codex credentials from ${authPath}. ` +
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
  try {
    return readCredentialsFromDisk();
  } catch { /* fall through to keychain */ }

  const fromKeychain = await readCredentialsFromKeychain();
  if (fromKeychain) return fromKeychain;

  throw new Error(
    'Could not read Claude credentials from disk or keychain. ' +
    'Make sure Claude Code is installed and you are logged in.'
  );
}
