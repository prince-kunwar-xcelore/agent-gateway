import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptToken } from './crypto';
import { readCredentials, type Agent } from './token-reader';

const CACHE_DIR  = path.join(os.homedir(), '.claude-proxy');
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// Claude keeps its original cache filename so existing caches stay valid.
const cacheFile = (agent: Agent): string =>
  path.join(CACHE_DIR, agent === 'claude' ? 'last-token.enc' : `last-token-${agent}.enc`);

export interface AgentState {
  /** Raw credentials — kept in memory only, never written to disk. */
  credentials:    string | null;
  /** Credentials encrypted with the serve-time public key (private-key mode). */
  encryptedToken: string | null;
  lastRefreshAt:  Date | null;
  lastError:      string | null;
}

const states = new Map<Agent, AgentState>();

function stateFor(agent: Agent): AgentState {
  let state = states.get(agent);
  if (!state) {
    state = { credentials: null, encryptedToken: null, lastRefreshAt: null, lastError: null };
    states.set(agent, state);
  }
  return state;
}

function writeCache(agent: Agent, encryptedToken: string): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(cacheFile(agent), encryptedToken, { mode: 0o600 });
}

function readCache(agent: Agent): string | null {
  try { return fs.readFileSync(cacheFile(agent), 'utf8'); }
  catch { return null; }
}

/**
 * Re-read credentials for one agent. When a public key is configured the
 * encrypted form is also refreshed and cached on disk; the raw credentials
 * only live in memory (for the OIDC mode, which encrypts per request).
 */
export async function refresh(agent: Agent, publicKeyPem: string | null): Promise<void> {
  const state = stateFor(agent);
  try {
    state.credentials = await readCredentials(agent);
    if (publicKeyPem) {
      state.encryptedToken = encryptToken(state.credentials, publicKeyPem);
      writeCache(agent, state.encryptedToken);
    }
    state.lastRefreshAt = new Date();
    state.lastError     = null;
    console.log(`[daemon] ${agent} credentials refreshed at ${state.lastRefreshAt.toISOString()}`);
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error(`[daemon] ${agent} refresh failed: ${state.lastError}`);
    if (publicKeyPem && !state.encryptedToken) {
      const cached = readCache(agent);
      if (cached) { state.encryptedToken = cached; console.warn(`[daemon] ${agent}: using cached token.`); }
      else         { console.error(`[daemon] ${agent}: no cache available. /token will return 503.`); }
    }
  }
}

export function startDaemon(agents: Agent[], publicKeyPem: string | null): () => void {
  const refreshAll = (): void => { for (const agent of agents) void refresh(agent, publicKeyPem); };
  refreshAll();
  const interval = setInterval(refreshAll, REFRESH_INTERVAL_MS);
  return () => clearInterval(interval);
}

export const getState = (agent: Agent): AgentState | null => {
  const state = states.get(agent);
  return state ? { ...state } : null;
};
export const getStates = (): Map<Agent, AgentState> => new Map(states);
