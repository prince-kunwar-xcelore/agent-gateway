import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Read Claude's OAuth token from disk.
 * Checks ~/.claude/.credentials.json first (current Claude Code format),
 * then falls back to ~/.claude/auth.json (older versions).
 */
function readTokenFromDisk(): string {
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const authPath = path.join(os.homedir(), '.claude', 'auth.json');

  if (fs.existsSync(credentialsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as {
        claudeAiOauth?: { accessToken?: string };
      };
      const token = parsed?.claudeAiOauth?.accessToken;
      if (token) return token;
    } catch { /* fall through */ }
  }

  if (fs.existsSync(authPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as {
        access_token?: string;
        accessToken?: string;
      };
      const token = parsed?.access_token ?? parsed?.accessToken;
      if (token) return token;
    } catch { /* fall through */ }
  }

  throw new Error(
    `Could not read Claude token. Checked: ${credentialsPath}, ${authPath}. ` +
    'Make sure Claude Code is installed and you are logged in.'
  );
}

/**
 * Try to read token via keytar (libsecret / system keychain).
 * Returns null if keytar is unavailable or the key is not found.
 */
async function readTokenFromKeychain(): Promise<string | null> {
  try {
    const keytar = await import('keytar');
    const token = await keytar.default.getPassword('claude-code', 'oauth-token');
    return token ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the current Claude.ai OAuth token.
 * Priority: system keychain → disk file.
 */
export async function readToken(): Promise<string> {
  return (await readTokenFromKeychain()) ?? readTokenFromDisk();
}
