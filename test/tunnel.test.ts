import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPublicHealth, installTunnel } from '../src/commands/tunnel';
import { defaultConfig, loadConfig, saveConfig } from '../src/config';
import type { ServiceManager, ServiceSpec } from '../src/service';

function fakeManager(failOn?: string): ServiceManager & { calls: string[] } {
  const calls: string[] = [];
  const step = (name: string) => () => {
    calls.push(name);
    if (name === failOn) throw new Error(`${name} failed`);
  };
  return {
    calls,
    unitPath: () => '/fake/unit',
    install: step('install'), uninstall: step('uninstall'), start: step('start'), stop: step('stop'),
    restart: step('restart'), enable: step('enable'), disable: step('disable'),
    state: () => ({ installed: true, active: false, enabled: true, detail: '' }),
    logs: () => {},
  };
}

const spec: ServiceSpec = { name: 'agent-gateway-tunnel', description: '', command: ['/bin/true'] };
const entry = { provider: 'cloudflare' as const, hostname: 'gw.example.com', tunnelName: 'agent-gateway' };

function tmpConfigFile(withTunnel: boolean): { file: string; config: ReturnType<typeof defaultConfig> } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tunnel-')), 'config.json');
  const config = defaultConfig();
  config.allowlist = { enabled: true, allow: ['github:a/*'], audience: 'agent-gateway' };
  if (withTunnel) config.tunnel = { provider: 'ngrok', hostname: 'old.ngrok-free.app' };
  saveConfig(file, config);
  return { file, config };
}

test('installTunnel records the tunnel only after the service started and verified', async () => {
  const { file, config } = tmpConfigFile(false);
  const manager = fakeManager();
  await installTunnel(manager, { spec, hostname: entry.hostname }, entry, file, config, async () => {});
  assert.deepEqual(manager.calls, ['install', 'enable', 'start']);
  assert.deepEqual(loadConfig(file)!.tunnel, entry);
});

test('installTunnel rolls back when start or verification fails', async () => {
  for (const [failOn, verifyFails] of [['start', false], [undefined, true]] as const) {
    const { file, config } = tmpConfigFile(true);
    const manager = fakeManager(failOn);
    await assert.rejects(
      installTunnel(manager, { spec, hostname: entry.hostname }, entry, file, config, async () => {
        if (verifyFails) throw new Error('answered by something else');
      }),
      /Rolled back/,
    );
    assert.equal(manager.calls.at(-1), 'uninstall');
    // The old tunnel's unit was replaced, so its config entry is gone too
    assert.equal(loadConfig(file)!.tunnel, undefined);
  }
});

test('checkPublicHealth tells this proxy from another one', async () => {
  const realFetch = globalThis.fetch;
  const respond = (status: number, body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  };
  const local = { ok: true, instance_id: 'abc', modes: { private_key: false, allowlist: true }, agents: {} };
  try {
    respond(200, { ...local });
    assert.equal((await checkPublicHealth('gw.example.com', local, 1, 0)).reach, 'this-proxy');
    respond(200, { ...local, instance_id: 'other' });
    assert.equal((await checkPublicHealth('gw.example.com', local, 2, 0)).reach, 'other');
    respond(404, '<html>');
    assert.deepEqual(await checkPublicHealth('gw.example.com', local, 1, 0), { reach: 'other', status: 404 });
    respond(530, 'tunnel not connected');
    assert.equal((await checkPublicHealth('gw.example.com', local, 2, 0)).reach, 'unreachable');
    // Local proxy not running: can only say whether some gateway answers
    respond(200, { ...local, instance_id: 'zzz' });
    assert.equal((await checkPublicHealth('gw.example.com', null, 1, 0)).reach, 'reachable');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('installTunnel keeps the previous tunnel when install fails before replacing its unit', async () => {
  const { file, config } = tmpConfigFile(true);
  const unit = path.join(path.dirname(file), 'tunnel.service');
  fs.writeFileSync(unit, 'old unit');
  const manager = fakeManager('install');
  manager.unitPath = () => unit;
  manager.state = () => ({ installed: true, active: true, enabled: true, detail: '' });
  await assert.rejects(
    installTunnel(manager, { spec, hostname: entry.hostname }, entry, file, config, async () => {}),
    /Nothing was changed; the previous tunnel service was restarted/,
  );
  assert.deepEqual(manager.calls, ['stop', 'install', 'start']);
  assert.equal(loadConfig(file)!.tunnel?.hostname, 'old.ngrok-free.app');
});
