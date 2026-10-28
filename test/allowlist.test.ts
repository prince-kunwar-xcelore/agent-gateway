import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowEntry, parseAllowList, trustedIssuers, entryAllows } from '../src/allowlist';
import { GITHUB_ISSUER, GITLAB_ISSUER } from '../src/issuers';

test('bare and github: entries bind to GitHub', () => {
  for (const e of ['Owner/*', 'github:owner/*']) {
    const parsed = parseAllowEntry(e);
    assert.equal(parsed.raw, 'github:owner/*');
    assert.equal(parsed.issuer, GITHUB_ISSUER);
  }
});

test('gitlab entries bind to gitlab.com or a self-hosted issuer', () => {
  assert.equal(parseAllowEntry('gitlab:group/sub/project').issuer, GITLAB_ISSUER);
  const selfHosted = parseAllowEntry('gitlab@https://git.example.com:8443/:team/*');
  assert.equal(selfHosted.issuer, 'https://git.example.com:8443');
  assert.equal(selfHosted.raw, 'gitlab@https://git.example.com:8443:team/*');
  assert.equal(parseAllowEntry(selfHosted.raw).raw, selfHosted.raw);
});

test('invalid entries are rejected', () => {
  for (const e of ['owner', 'owner/', '*', 'owner/repo/extra', 'owner/*/x', 'own er/repo', 'gitlab:group', 'gitlab@http://insecure:g/*', 'gitlab@:g/*']) {
    assert.throws(() => parseAllowEntry(e), /Invalid allow entry/, e);
  }
});

test('parseAllowList dedupes case-insensitively and trusts only named issuers', () => {
  const list = parseAllowList(['owner/*', 'github:OWNER/*', 'owner/repo']);
  assert.deepEqual(list.map((e) => e.raw), ['github:owner/*', 'github:owner/repo']);
  assert.deepEqual(trustedIssuers(list), [GITHUB_ISSUER]);
});

test('a GitHub entry does not match a gitlab.com namespace with the same name', () => {
  const [entry] = parseAllowList(['owner/*']);
  assert.equal(entryAllows(entry, GITHUB_ISSUER, { repository: 'owner/repo' }), true);
  assert.equal(entryAllows(entry, GITLAB_ISSUER, { project_path: 'owner/repo' }), false);
  // Even a GitLab token carrying a forged-looking `repository` claim is read via project_path
  const [gitlab] = parseAllowList(['gitlab:owner/*']);
  assert.equal(entryAllows(gitlab, GITLAB_ISSUER, { repository: 'owner/repo' }), false);
  assert.equal(entryAllows(gitlab, GITLAB_ISSUER, { project_path: 'Owner/Sub/Repo' }), true);
});

test('owner/* does not match an empty repo name', () => {
  const [entry] = parseAllowList(['owner/*']);
  assert.equal(entryAllows(entry, GITHUB_ISSUER, { repository: 'owner/' }), false);
  assert.equal(entryAllows(entry, GITHUB_ISSUER, { repository: 'owner/r' }), true);
});
