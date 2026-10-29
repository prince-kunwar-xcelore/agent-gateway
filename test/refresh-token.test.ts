import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialsExpiry, withoutRefreshToken } from '../src/token-reader';
import { getState, refresh } from '../src/daemon';

const jwt = (claims: object): string =>
  ['{"alg":"none"}', JSON.stringify(claims), ''].map((p) => Buffer.from(p).toString('base64url')).join('.');

test('withoutRefreshToken strips Claude refresh tokens and blanks Codex ones', () => {
  const claude = JSON.parse(withoutRefreshToken('claude', JSON.stringify({
    claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: 1, expiresAt: 2, scopes: ['x'] },
  })));
  assert.deepEqual(claude, { claudeAiOauth: { accessToken: 'a', expiresAt: 2, scopes: ['x'] } });
  assert.deepEqual(JSON.parse(withoutRefreshToken('claude', '{"access_token":"a","refresh_token":"r"}')), { access_token: 'a' });

  const before = Date.now();
  const codex = JSON.parse(withoutRefreshToken('codex', JSON.stringify({
    tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' }, last_refresh: '2020-01-01T00:00:00Z',
  })));
  assert.equal(codex.tokens.refresh_token, '');
  assert.equal(codex.tokens.access_token, 'a');
  assert.ok(Date.parse(codex.last_refresh) >= before - 1000);
  // API-key auth has nothing to strip
  assert.equal(withoutRefreshToken('codex', '{"OPENAI_API_KEY":"k"}'), '{"OPENAI_API_KEY":"k"}');
});

test('credentialsExpiry reads Claude expiresAt and the Codex access-token exp', () => {
  assert.equal(credentialsExpiry('claude', '{"claudeAiOauth":{"accessToken":"a","expiresAt":123}}'), 123);
  assert.equal(credentialsExpiry('codex', JSON.stringify({ tokens: { access_token: jwt({ exp: 456 }) } })), 456_000);
  assert.equal(credentialsExpiry('codex', '{"OPENAI_API_KEY":"k"}'), null);
  assert.equal(credentialsExpiry('claude', 'not json'), null);
});

test('the daemon serves stripped credentials and refuses expired ones', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-codex-'));
  const saved = { CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH };
  process.env.CODEX_HOME = codexHome;
  // No codex on PATH: the local refresh attempt must fail cleanly
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-path-'));
  const write = (exp: number): void => fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    tokens: { access_token: jwt({ exp }), refresh_token: 'secret-refresh' },
  }));
  try {
    write(Math.floor(Date.now() / 1000) + 5 * 24 * 3600);
    await refresh('codex', null);
    let state = getState('codex')!;
    assert.equal(state.lastError, null);
    assert.ok(!state.credentials!.includes('secret-refresh'));
    assert.equal(state.lastLocalRefresh, null);

    write(Math.floor(Date.now() / 1000) - 60);
    await refresh('codex', null);
    state = getState('codex')!;
    assert.equal(state.credentials, null);
    assert.match(state.lastError!, /codex access token expired at .* Local refresh failed: codex not found on PATH/);
    assert.match(state.lastLocalRefresh!.error!, /not found on PATH/);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved.CODEX_HOME;
  }
});

test('an expiring Claude login is refreshed by running the CLI locally', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-bin-'));
  const credentials = path.join(home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(credentials));
  const write = (expiresAt: number, accessToken: string): void =>
    fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'r', expiresAt } }));
  write(Date.now() + 60 * 1000, 'old');
  // Stand-in for `claude -p …`: rewrites the credentials like a real refresh would
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
cat > "${credentials}" <<JSON
{"claudeAiOauth":{"accessToken":"new","refreshToken":"r2","expiresAt":${Date.now() + 8 * 3600 * 1000}}}
JSON
`, { mode: 0o755 });

  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    await refresh('claude', null);
    const state = getState('claude')!;
    assert.equal(state.lastError, null);
    assert.deepEqual(state.lastLocalRefresh?.error, null);
    assert.equal(JSON.parse(state.credentials!).claudeAiOauth.accessToken, 'new');
    assert.ok(!state.credentials!.includes('r2'));
    assert.ok(state.expiresAt!.getTime() > Date.now() + 7 * 3600 * 1000);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
  }
});
