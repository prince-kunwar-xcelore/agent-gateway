import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getArg, getArgs, parseCommandArgs, parseHostname, parsePort } from '../src/args';

test('value flags need a value that is not another flag', () => {
  assert.throws(() => getArgs(['--allow', '--port', '7432'], '--allow'), /--allow needs a value/);
  assert.throws(() => getArgs(['--allow'], '--allow'), /--allow needs a value/);
  assert.throws(() => getArg(['--port'], '--port'), /--port needs a value/);
  assert.deepEqual(getArgs(['--allow', 'a/*,b/*', '--allow', 'c/d'], '--allow'), ['a/*', 'b/*', 'c/d']);
  assert.equal(getArg([], '--port', '1'), '1');
});

test('parseCommandArgs rejects unknown flags and returns positionals', () => {
  assert.deepEqual(parseCommandArgs('allow', ['add', 'a/*', '--config', '/x.json', 'b/*', '--no-restart']), ['add', 'a/*', 'b/*']);
  assert.throws(() => parseCommandArgs('allow', ['add', 'a/*', '--force']), /Unknown option "--force" for "allow"/);
  assert.throws(() => parseCommandArgs('init', ['--allow', '--port', '1']), /--allow needs a value/);
  assert.throws(() => parseCommandArgs('serve', ['--prot', '1']), /Unknown option "--prot"/);
  assert.deepEqual(parseCommandArgs('service', ['logs', '-f']), ['logs']);
});

test('parsePort and parseHostname reject malformed values', () => {
  assert.equal(parsePort('7432'), 7432);
  for (const bad of ['0', '65536', '7432abc', '-1', '']) assert.throws(() => parsePort(bad), /Invalid --port/);
  assert.equal(parseHostname('--hostname', 'GW.Example.com'), 'gw.example.com');
  for (const bad of ['https://gw.example.com', 'gw.example.com/x', 'gw.example.com:443', 'localhost', 'a b.com']) {
    assert.throws(() => parseHostname('--hostname', bad), /Invalid --hostname/);
  }
});
