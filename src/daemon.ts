import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { encryptToken } from './crypto';
import { which } from './service';
import { credentialsExpiry, readCredentials, withoutRefreshToken, type Agent } from './token-reader';

const CACHE_DIR  = path.join(os.homedir(), '.agent-gateway');
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// Timers don't advance while the machine sleeps, so staleness is checked against the wall clock
const CHECK_INTERVAL_MS = 60 * 1000;
// /token re-reads credentials older than this, so a request right after resume never gets a stale copy
const MAX_SERVE_AGE_MS = 60 * 1000;
// Served credentials can't be refreshed by CI, so don't hand out ones about to expire
const MIN_SERVE_VALIDITY_MS = 2 * 60 * 1000;

/**
 * Served credentials have no refresh token, so the local CLI must keep them
 * fresh. Nobody may use it for hours (overnight), so when the access token is
 * this close to expiry the daemon runs the CLI once with a trivial prompt,
 * which makes it refresh and rewrite its credentials file. The window matches
 * when each CLI refreshes on its own: Claude shortly before expiry, Codex
 * when its last refresh is ~8 days old (tokens last ~10).
 */
const LOCAL_REFRESH_AHEAD_MS: Record<Agent, number> = { claude: 10 * 60 * 1000, codex: 24 * 3600 * 1000 };
const LOCAL_REFRESH_MIN_INTERVAL_MS = 4 * 60 * 1000;
const LOCAL_REFRESH_TIMEOUT_MS = 2 * 60 * 1000;
const LOCAL_REFRESH_COMMANDS: Record<Agent, string[]> = {
  // No tools and no saved session: the run exists only to make the CLI refresh its login
  claude: ['claude', '-p', 'Reply with OK', '--tools', '', '--no-session-persistence'],
  codex:  ['codex', 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', 'Reply with OK'],
};

const cacheFile = (agent: Agent): string => path.join(CACHE_DIR, `last-token-${agent}.enc`);

export interface AgentState {
  /** Credentials as served (refresh token removed) — kept in memory only, never written to disk. */
  credentials:    string | null;
  /** Credentials encrypted with the serve-time public key (private-key mode). */
  encryptedToken: string | null;
  lastRefreshAt:  Date | null;
  lastError:      string | null;
  /** Access-token expiry; null when the credentials don't carry one (API keys). */
  expiresAt:      Date | null;
  lastLocalRefresh: { at: Date; error: string | null } | null;
}

const states = new Map<Agent, AgentState>();
const localRefreshes = new Map<Agent, Promise<void>>();

function stateFor(agent: Agent): AgentState {
  let state = states.get(agent);
  if (!state) {
    state = { credentials: null, encryptedToken: null, lastRefreshAt: null, lastError: null, expiresAt: null, lastLocalRefresh: null };
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

class ExpiredError extends Error {}

/** Run the agent's CLI once so it refreshes its own login. One run at a time, rate-limited. */
function runLocalRefresh(agent: Agent): Promise<void> {
  const running = localRefreshes.get(agent);
  if (running) return running;
  const state = stateFor(agent);
  if (state.lastLocalRefresh && Date.now() - state.lastLocalRefresh.at.getTime() < LOCAL_REFRESH_MIN_INTERVAL_MS) {
    return Promise.resolve();
  }

  const [bin, ...args] = LOCAL_REFRESH_COMMANDS[agent];
  const promise = (async () => {
    let error: string | null = null;
    const resolved = which(bin);
    if (!resolved) {
      error = `${bin} not found on PATH (${process.env.PATH ?? ''}); reinstall the service with "service install --force" from a shell where ${bin} is on PATH`;
    } else {
      console.log(`[daemon] ${agent} access token expires soon; running ${bin} locally to refresh the login`);
      try {
        await promisify(execFile)(resolved, args, { cwd: os.tmpdir(), timeout: LOCAL_REFRESH_TIMEOUT_MS });
      } catch (err) {
        const e = err as { stderr?: string; message: string };
        error = `${bin} failed: ${(e.stderr?.trim() || e.message).slice(0, 300)}`;
      }
    }
    state.lastLocalRefresh = { at: new Date(), error };
    if (error) console.error(`[daemon] ${agent} local refresh: ${error}`);
  })().finally(() => localRefreshes.delete(agent));
  localRefreshes.set(agent, promise);
  return promise;
}

/**
 * Re-read credentials for one agent, refreshing the local login first when
 * the access token is about to expire. When a public key is configured the
 * encrypted form is also refreshed and cached on disk; the raw credentials
 * only live in memory (for the OIDC mode, which encrypts per request).
 */
export async function refresh(agent: Agent, publicKeyPem: string | null): Promise<void> {
  const state = stateFor(agent);
  try {
    let raw = await readCredentials(agent);
    let expiresAt = credentialsExpiry(agent, raw);
    state.expiresAt = expiresAt === null ? null : new Date(expiresAt);
    if (expiresAt !== null && expiresAt - Date.now() < LOCAL_REFRESH_AHEAD_MS[agent]) {
      await runLocalRefresh(agent);
      raw = await readCredentials(agent);
      expiresAt = credentialsExpiry(agent, raw);
      state.expiresAt = expiresAt === null ? null : new Date(expiresAt);
    }
    if (expiresAt !== null && expiresAt - Date.now() < MIN_SERVE_VALIDITY_MS) {
      const last = state.lastLocalRefresh;
      const local = !last ? ''
        : last.error ? ` Local refresh failed: ${last.error}.`
        : ` Local refresh last ran at ${last.at.toISOString()} without renewing it (retried every ${LOCAL_REFRESH_MIN_INTERVAL_MS / 60000} min).`;
      throw new ExpiredError(
        `${agent} access token ${expiresAt <= Date.now() ? 'expired' : 'expires'} at ${new Date(expiresAt).toISOString()} and was not refreshed.${local} ` +
        `Run ${agent} on this machine (log in again if asked).`,
      );
    }

    state.credentials = withoutRefreshToken(agent, raw);
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
    if (err instanceof ExpiredError || (state.expiresAt && state.expiresAt.getTime() - Date.now() < MIN_SERVE_VALIDITY_MS)) {
      // Credentials held from earlier are at least as old: serve nothing rather than a dead token
      state.credentials = null;
      state.encryptedToken = null;
      return;
    }
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

const expiresSoon = (agent: Agent): boolean => {
  const at = states.get(agent)?.expiresAt;
  return at !== null && at !== undefined && at.getTime() - Date.now() < LOCAL_REFRESH_AHEAD_MS[agent];
};

export function startDaemon(agents: Agent[], publicKeyPem: string | null): () => void {
  daemonPublicKey = publicKeyPem;
  for (const agent of agents) void refresh(agent, publicKeyPem);
  const interval = setInterval(() => {
    for (const agent of agents) {
      if (ageMs(agent) >= REFRESH_INTERVAL_MS || expiresSoon(agent)) void refresh(agent, publicKeyPem);
    }
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
