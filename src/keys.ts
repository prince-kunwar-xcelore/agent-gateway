import crypto from 'node:crypto';
import fs from 'node:fs';

/** Generate an RSA-4096 keypair and write both PEM files to disk. */
export function generateKeypair(
  privateKeyPath = 'private.pem',
  publicKeyPath = 'public.pem'
): void {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, publicKey);
  console.log(`Keypair written:\n  private → ${privateKeyPath}\n  public  → ${publicKeyPath}`);
}
