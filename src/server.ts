import http from 'node:http';
import { getEncryptedToken, getLastRefreshAt, getState } from './daemon';

export interface ServerOptions {
  port: number;
}

/**
 * Create and return the HTTP server (not yet listening).
 * Routes:
 *   GET /token  → 200 base64-encoded encrypted token, or 503 if unavailable
 *   GET /health → 200 JSON with ok flag and token age in seconds
 *   *           → 404
 */
export function createServer(): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    if (url === '/token') {
      handleToken(req, res);
    } else if (url === '/health') {
      handleHealth(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  return server;
}

function handleToken(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const token = getEncryptedToken();

  if (!token) {
    const { lastError } = getState();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Token not available', detail: lastError }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-store',
  });
  res.end(token);
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const lastRefreshAt = getLastRefreshAt();
  const { lastError } = getState();

  const ageSeconds = lastRefreshAt
    ? Math.floor((Date.now() - lastRefreshAt.getTime()) / 1000)
    : null;

  const ok = lastRefreshAt !== null && lastError === null;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      ok,
      age_seconds: ageSeconds,
      last_refresh: lastRefreshAt?.toISOString() ?? null,
      last_error: lastError,
    })
  );
}

/**
 * Start the HTTP server on the given port.
 * Returns a cleanup function to close it.
 */
export function startServer(port: number): () => void {
  const server = createServer();

  server.listen(port, () => {
    console.log(`[server] Listening on http://localhost:${port}`);
    console.log(`[server]   GET /token  → encrypted Claude token`);
    console.log(`[server]   GET /health → daemon health status`);
  });

  return () =>
    server.close((err) => {
      if (err) console.error('[server] Error closing server:', err);
      else console.log('[server] Closed.');
    });
}
