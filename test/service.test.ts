import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemdQuote } from '../src/service';

test('systemdQuote escapes variables, specifiers, spaces and quotes', () => {
  assert.equal(systemdQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(systemdQuote('/home/$USER/50%/x'), '/home/$$USER/50%%/x');
  assert.equal(systemdQuote('/path with space/a"b'), '"/path with space/a\\"b"');
});

test('unit file values reject control characters and quote Environment assignments', async () => {
  const { systemdEnv } = await import('../src/service');
  assert.throws(() => systemdQuote('a\nExecStartPre=/bin/evil'), /Control characters/);
  assert.equal(systemdEnv('HOME', '/home/a b/50%'), '"HOME=/home/a b/50%%"');
  assert.equal(systemdEnv('X', 'say "hi" \\o/'), '"X=say \\"hi\\" \\\\o/"');
  assert.throws(() => systemdEnv('HOME', '/x\n'), /Control characters/);
});
