import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Fetches the encrypted token from a running claude-token-proxy daemon.
 * Returns the raw base64-encoded encrypted token string.
 */
export function fetchEncryptedToken(proxyUrl: string): Promise<string> {
  const tokenUrl = new URL('/token', proxyUrl).toString();
  const driver = tokenUrl.startsWith('https') ? https : http;

  return new Promise((resolve, reject) => {
    const req = driver.get(tokenUrl, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Proxy returned HTTP ${res.statusCode} from ${tokenUrl}`));
        res.resume();
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${tokenUrl} timed out after 10s`));
    });

    req.on('error', reject);
  });
}
