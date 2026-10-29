import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicOidcReason } from '../src/server';
import { OidcError } from '../src/oidc';

test('403 details name the failed check without configuration details', () => {
  const err = new OidcError('Audience mismatch', 'expected my-secret-aud');
  assert.equal(err.message, 'Audience mismatch: expected my-secret-aud');
  assert.equal(publicOidcReason(err), 'Audience mismatch');
  assert.equal(publicOidcReason(new Error('HTTP 500 from https://internal.example.com/jwks')), 'Token could not be verified');
});
