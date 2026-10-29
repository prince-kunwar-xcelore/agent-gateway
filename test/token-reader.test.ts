import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCredentials } from '../src/token-reader';

const tmpHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));

test('errors say why each Claude credentials file was skipped', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{ not json');
  fs.writeFileSync(path.join(home, '.claude', 'auth.json'), JSON.stringify({ refresh_token: 'x' }));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await assert.rejects(readCredentials('claude'), (err: Error) => {
      assert.match(err.message, /\.credentials\.json: invalid JSON/);
      assert.match(err.message, /auth\.json: no access token in it/);
      assert.match(err.message, /keychain: /);
      return true;
    });
  } finally {
    process.env.HOME = savedHome;
  }
});

test('errors say why the Codex auth file was skipped, and valid files are returned as-is', async () => {
  const codexHome = tmpHome();
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    await assert.rejects(readCredentials('codex'), /auth\.json: not found/);
    const raw = JSON.stringify({ tokens: { access_token: 'a' } });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), raw);
    assert.equal(await readCredentials('codex'), raw);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});
