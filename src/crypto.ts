import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Encrypts a raw token using hybrid encryption:
 *   - AES-256-GCM  encrypts the token  (handles arbitrary length)
 *   - RSA-OAEP     encrypts the AES key (key exchange only)
 *
 * Encoded layout (concatenated, then base64):
 *   [ RSA-encrypted AES key : 512 bytes ]
 *   [ AES-GCM IV            :  12 bytes ]
 *   [ AES-GCM auth tag      :  16 bytes ]
 *   [ AES-GCM ciphertext    :   N bytes ]
 */
export function encryptToken(token: string, publicKeyPem: string): string {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const encryptedAesKey = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    aesKey
  );

  return Buffer.concat([encryptedAesKey, iv, tag, ciphertext]).toString('base64');
}

/** Decrypts a base64 encrypted token produced by encryptToken. */
export function decryptToken(encryptedToken: string, privateKeyPem: string): string {
  const buf = Buffer.from(encryptedToken, 'base64');

  const encryptedAesKey = buf.subarray(0, 512);
  const iv              = buf.subarray(512, 524);
  const tag             = buf.subarray(524, 540);
  const ciphertext      = buf.subarray(540);

  const aesKey = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    encryptedAesKey
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/** Read a PEM file from disk. */
export function loadPem(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}
