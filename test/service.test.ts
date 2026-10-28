import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemdQuote } from '../src/service';

test('systemdQuote escapes variables, specifiers, spaces and quotes', () => {
  assert.equal(systemdQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(systemdQuote('/home/$USER/50%/x'), '/home/$$USER/50%%/x');
  assert.equal(systemdQuote('/path with space/a"b'), '"/path with space/a\\"b"');
});
