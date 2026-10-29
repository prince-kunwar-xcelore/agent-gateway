import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveServeConfig, saveConfig, loadConfig, defaultConfig, validateConfig } from '../src/config';

const tmpConfig = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-config-')), 'config.json');

test('no config file and no flags: private-key mode with ./public.pem (legacy default)', () => {
  const { config, source } = resolveServeConfig([], tmpConfig());
  assert.equal(source, null);
  assert.deepEqual(config.privateKey, { enabled: true, publicKeyPath: path.resolve('public.pem') });
  assert.equal(config.allowlist.enabled, false);
});

test('no config file with --allow: allowlist only', () => {
  const { config } = resolveServeConfig(['--allow', 'owner/*'], tmpConfig());
  assert.equal(config.privateKey.enabled, false);
  assert.deepEqual(config.allowlist.allow, ['owner/*']);
});

test('flags override the config file field by field', () => {
  const file = tmpConfig();
  const saved = defaultConfig();
  saved.allowlist = { enabled: true, allow: ['github:a/*'], audience: 'agent-gateway' };
  saved.port = 9000;
  saveConfig(file, saved);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const { config, source } = resolveServeConfig(['--config', file, '--port', '9001']);
  assert.equal(source, file);
  assert.equal(config.port, 9001);
  assert.deepEqual(config.allowlist.allow, ['github:a/*']);
  // A config file never implies the ./public.pem default
  assert.equal(config.privateKey.enabled, false);

  const overridden = resolveServeConfig(['--config', file, '--allow', 'b/*', '--public-key', 'k.pem']).config;
  assert.deepEqual(overridden.allowlist.allow, ['b/*']);
  assert.deepEqual(overridden.privateKey, { enabled: true, publicKeyPath: path.resolve('k.pem') });
});

test('partial config files are filled from defaults', () => {
  const file = tmpConfig();
  fs.writeFileSync(file, JSON.stringify({ allowlist: { enabled: true, allow: ['x/*'] } }));
  const config = loadConfig(file)!;
  assert.equal(config.port, 7432);
  assert.equal(config.allowlist.audience, 'agent-gateway');
  assert.deepEqual(validateConfig(config), []);
});

test('validateConfig rejects both modes off, bad entries and unknown agents', () => {
  const config = defaultConfig();
  assert.match(validateConfig(config).join(), /Both auth modes are disabled/);
  config.allowlist = { enabled: true, allow: ['nope'], audience: 'x' };
  config.agents = ['gemini' as never];
  const errors = validateConfig(config).join('\n');
  assert.match(errors, /Invalid allow entry/);
  assert.match(errors, /Unknown agent/);
});

test('corrupt config files report the file path', () => {
  const file = tmpConfig();
  fs.writeFileSync(file, '{ "port": 7432, ');
  assert.throws(() => loadConfig(file), new RegExp(`Invalid JSON in ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('validateConfig reports wrongly typed fields from hand-edited files', () => {
  const file = tmpConfig();
  fs.writeFileSync(file, JSON.stringify({ agents: 'claude', privateKey: null, allowlist: { enabled: true, allow: 'x/*' } }));
  const errors = validateConfig(loadConfig(file)!).join('\n');
  assert.match(errors, /"agents" must be an array/);
  assert.match(errors, /"privateKey" must be an object/);
  assert.match(errors, /"allowlist.allow" must be an array/);
});

test('an explicit --config that does not exist is an error', () => {
  const file = tmpConfig();
  assert.throws(() => resolveServeConfig(['--config', file]), new RegExp(`Config file not found: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('serve flags are validated', () => {
  const file = tmpConfig();
  assert.throws(() => resolveServeConfig(['--port', '7432abc'], file), /Invalid --port "7432abc"/);
  assert.throws(() => resolveServeConfig(['--port', '70000'], file), /Invalid --port/);
  assert.throws(() => resolveServeConfig(['--agents', 'claude,'], file), /empty entry/);
  assert.throws(() => resolveServeConfig(['--agents', 'claude,gemini'], file), /Unknown agent\(s\) in --agents: gemini/);
  assert.deepEqual(resolveServeConfig(['--agents', 'codex,codex', '--port', '7433'], file).config.agents, ['codex']);
});

test('config files that are not JSON objects are rejected clearly', () => {
  const file = tmpConfig();
  fs.writeFileSync(file, 'null');
  assert.throws(() => loadConfig(file), /must contain a JSON object/);
});
