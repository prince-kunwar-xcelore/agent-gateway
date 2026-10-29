import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicOidcReason } from '../src/server';

test('403 details name the failed check without configuration details', () => {
  assert.equal(publicOidcReason('Audience mismatch: expected my-secret-aud'), 'Audience mismatch');
  assert.equal(publicOidcReason('No JWKS key matches kid abc'), 'No JWKS key matches kid');
  assert.equal(publicOidcReason('Repository not allowlisted for https://token.actions.githubusercontent.com: a/b'), 'Repository not allowlisted');
  assert.equal(
    publicOidcReason('Repository not allowlisted for https://x: a/b matches an entry but not its claim constraints'),
    'Repository matches an allow entry but not its claim constraints',
  );
  assert.equal(publicOidcReason('HTTP 500 from https://internal.example.com/jwks'), 'Token could not be verified');
});
