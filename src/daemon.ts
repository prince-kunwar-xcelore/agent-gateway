import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptToken } from './crypto';
import { readToken } from './token-reader';

const CACHE_DIR  = path.join(os.homedir(), '.claude-proxy');
const CACHE_FILE = path.join(CACHE_DIR, 'last-token.enc');
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export interface DaemonState {
  encryptedToken: string | null;
  lastRefreshAt:  Date | null;
  lastError:      string | null;
}

const state: DaemonState = {
  encryptedToken: null,
  lastRefreshAt:  null,
  lastError:      null,
};

function writeCache(encryptedToken: string): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CACHE_FILE, encryptedToken, { mode: 0o600 });
}

function readCache(): string | null {
  try { return fs.readFileSync(CACHE_FILE, 'utf8'); }
  catch { return null; }
}

export async function refresh(publicKeyPem: string): Promise<void> {
  try {
    const token = await readToken();
    state.encryptedToken = encryptToken(token, publicKeyPem);
    state.lastRefreshAt  = new Date();
    state.lastError      = null;
    writeCache(state.encryptedToken);
    console.log(`[daemon] Token refreshed at ${state.lastRefreshAt.toISOString()}`);
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error(`[daemon] Refresh failed: ${state.lastError}`);
    if (!state.encryptedToken) {
      const cached = readCache();
      if (cached) { state.encryptedToken = cached; console.warn('[daemon] Using cached token.'); }
      else         { console.error('[daemon] No cache available. /token will return 503.'); }
    }
  }
}

export function startDaemon(publicKeyPem: string): () => void {
  void refresh(publicKeyPem);
  const interval = setInterval(() => void refresh(publicKeyPem), REFRESH_INTERVAL_MS);
  return () => clearInterval(interval);
}

export const getState          = (): DaemonState  => ({ ...state });
export const getEncryptedToken = (): string | null => state.encryptedToken;
export const getLastRefreshAt  = (): Date | null   => state.lastRefreshAt;
