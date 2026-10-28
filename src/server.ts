import http from 'node:http';
import crypto from 'node:crypto';
import { encryptToken } from './crypto';
import { getState, getStates } from './daemon';
import { verifyOidcToken, repoFromClaims, type OidcOptions } from './oidc';
import type { Agent } from './token-reader';

export interface ServerOptions {
  /** Agents this proxy serves. */
  agents: Agent[];
  /** Private-key mode is enabled when serve was given a public key. */
  keyMode: boolean;
  /** OIDC allowlist mode is enabled when non-null. */
  oidc: OidcOptions | null;
}

const MAX_BODY_BYTES = 16 * 1024;

class BodyTooLargeError extends Error {}

/**
 * Create and return the HTTP server (not yet listening).
 * Routes:
 *   GET  /token?agent=claude|codex → credentials encrypted with the serve-time
 *                                     public key (private-key mode)
 *   POST /token?agent=claude|codex → Authorization: Bearer <CI OIDC token>,
 *                                     body {"publicKey": "<PEM>"}; credentials
 *                                     encrypted with that key (allowlist mode)
 *   GET  /health                   → JSON with per-agent status
 *   *                              → 404
 * `agent` defaults to claude.
 */
export function createServer(opts: ServerOptions): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/token' && req.method === 'GET') {
      handleKeyToken(url, res, opts);
    } else if (url.pathname === '/token' && req.method === 'POST') {
      handleOidcToken(url, req, res, opts).catch((err: unknown) => {
        console.error(`[server] POST /token failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      });
    } else if (url.pathname === '/health' && req.method === 'GET') {
      handleHealth(res, opts);
    } else if (url.pathname === '/token' || url.pathname === '/health') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
    } else {
      sendJson(res, 404, { error: 'Not Found' });
    }
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendToken(res: http.ServerResponse, token: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-store',
  });
  res.end(token);
}

/** Resolve ?agent=, replying with an error and returning null if invalid. */
function resolveAgent(url: URL, res: http.ServerResponse, opts: ServerOptions): Agent | null {
  const agent = (url.searchParams.get('agent') ?? 'claude') as Agent;
  if (!opts.agents.includes(agent)) {
    sendJson(res, 400, { error: `Unsupported agent "${agent}". Served: ${opts.agents.join(', ')}` });
    return null;
  }
  return agent;
}

function handleKeyToken(url: URL, res: http.ServerResponse, opts: ServerOptions): void {
  if (!opts.keyMode) {
    sendJson(res, 403, { error: 'Private-key mode is disabled on this proxy; use POST /token with an OIDC token' });
    return;
  }
  const agent = resolveAgent(url, res, opts);
  if (!agent) return;

  const state = getState(agent);
  if (!state?.encryptedToken) {
    sendJson(res, 503, { error: 'Token not available', detail: state?.lastError ?? null });
    return;
  }
  sendToken(res, state.encryptedToken);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Stop reading but keep the socket so the 413 can be delivered; it is closed after the response
      if (size > MAX_BODY_BYTES) { req.pause(); reject(new BodyTooLargeError('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleOidcToken(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ServerOptions,
): Promise<void> {
  if (!opts.oidc) {
    sendJson(res, 403, { error: 'Allowlist mode is disabled on this proxy; start serve with --allow' });
    return;
  }
  const agent = resolveAgent(url, res, opts);
  if (!agent) return;

  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'Missing Authorization: Bearer <OIDC token>' });
    return;
  }

  let repo: string | null;
  try {
    const claims = await verifyOidcToken(auth.slice('Bearer '.length).trim(), opts.oidc);
    repo = repoFromClaims(claims);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[server] OIDC rejected (${agent}): ${reason}`);
    sendJson(res, 403, { error: 'OIDC verification failed', detail: reason });
    return;
  }

  // Parse the submitted key only after the caller is authenticated
  let publicKeyPem: string;
  try {
    const body = JSON.parse(await readBody(req)) as { publicKey?: string };
    if (!body.publicKey) throw new Error('missing publicKey');
    // Reject anything that isn't the RSA-4096 key the response layout expects
    const key = crypto.createPublicKey(body.publicKey);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 4096) {
      throw new Error('publicKey must be an RSA-4096 PEM');
    }
    publicKeyPem = body.publicKey;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: `Body exceeds ${MAX_BODY_BYTES} bytes` }), () => req.destroy());
      return;
    }
    sendJson(res, 400, { error: `Invalid body: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  const state = getState(agent);
  if (!state?.credentials) {
    sendJson(res, 503, { error: 'Token not available', detail: state?.lastError ?? null });
    return;
  }

  console.log(`[server] Served ${agent} credentials to ${repo} (OIDC)`);
  sendToken(res, encryptToken(state.credentials, publicKeyPem));
}

function handleHealth(res: http.ServerResponse, opts: ServerOptions): void {
  const agents: Record<string, unknown> = {};
  let ok = true;

  for (const agent of opts.agents) {
    const state = getStates().get(agent);
    const lastRefreshAt = state?.lastRefreshAt ?? null;
    const agentOk = lastRefreshAt !== null && !state?.lastError;
    ok &&= agentOk;
    agents[agent] = {
      ok: agentOk,
      age_seconds: lastRefreshAt ? Math.floor((Date.now() - lastRefreshAt.getTime()) / 1000) : null,
      last_refresh: lastRefreshAt?.toISOString() ?? null,
      last_error: state?.lastError ?? null,
    };
  }

  sendJson(res, 200, {
    ok,
    modes: { private_key: opts.keyMode, allowlist: opts.oidc !== null },
    agents,
  });
}

/**
 * Start the HTTP server on the given port.
 * Returns a cleanup function to close it.
 */
export function startServer(port: number, opts: ServerOptions): () => void {
  const server = createServer(opts);

  server.listen(port, () => {
    console.log(`[server] Listening on http://localhost:${port}`);
    console.log(`[server]   Agents: ${opts.agents.join(', ')}`);
    if (opts.keyMode) console.log('[server]   GET  /token?agent=<agent> → encrypted with serve public key');
    if (opts.oidc)    console.log(`[server]   POST /token?agent=<agent> → OIDC allowlist: ${opts.oidc.allow.join(', ')}`);
    console.log('[server]   GET  /health');
  });

  return () =>
    server.close((err) => {
      if (err) console.error('[server] Error closing server:', err);
      else console.log('[server] Closed.');
    });
}
