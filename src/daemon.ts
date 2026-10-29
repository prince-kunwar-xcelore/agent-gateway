import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptToken } from './crypto';
import { readCredentials, type Agent } from './token-reader';

const CACHE_DIR  = path.join(os.homedir(), '.agent-gateway');
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// Timers don't advance while the machine sleeps, so staleness is checked against the wall clock
const CHECK_INTERVAL_MS = 60 * 1000;
// /token re-reads credentials older than this, so a request right after resume never gets a stale copy
const MAX_SERVE_AGE_MS = 60 * 1000;

const cacheFile = (agent: Agent): string => path.join(CACHE_DIR, `last-token-${agent}.enc`);

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

let daemonPublicKey: string | null = null;

const ageMs = (agent: Agent): number => {
  const at = states.get(agent)?.lastRefreshAt;
  return at ? Date.now() - at.getTime() : Infinity;
};

export function startDaemon(agents: Agent[], publicKeyPem: string | null): () => void {
  daemonPublicKey = publicKeyPem;
  for (const agent of agents) void refresh(agent, publicKeyPem);
  const interval = setInterval(() => {
    for (const agent of agents) if (ageMs(agent) >= REFRESH_INTERVAL_MS) void refresh(agent, publicKeyPem);
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(interval);
}

/** Re-read an agent's credentials if they are older than MAX_SERVE_AGE_MS. Called before serving them. */
export async function ensureFresh(agent: Agent): Promise<void> {
  if (ageMs(agent) >= MAX_SERVE_AGE_MS) await refresh(agent, daemonPublicKey);
}

export const getState = (agent: Agent): AgentState | null => {
  const state = states.get(agent);
  return state ? { ...state } : null;
};
export const getStates = (): Map<Agent, AgentState> =>
  new Map([...states].map(([agent, state]) => [agent, { ...state }]));
