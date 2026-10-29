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

test('self-hosted issuers are normalised to match the token iss', () => {
  assert.equal(parseAllowEntry('gitlab@https://Git.Example.COM:443/:team/*').issuer, 'https://git.example.com');
  assert.equal(parseAllowEntry('gitlab@https://git.example.com/gitlab/:team/*').issuer, 'https://git.example.com/gitlab');
});

test('self-hosted issuers with a query, credentials or a forgotten pattern are rejected', () => {
  for (const e of ['gitlab@https://git.example.com?x=1:g/*', 'gitlab@https://u:p@git.example.com:g/*', 'gitlab@https://git.example.com:8443/*']) {
    assert.throws(() => parseAllowEntry(e), /Invalid allow entry/, e);
  }
});

test('constraints are validated per platform and must name a listed entry', () => {
  assert.throws(() => parseAllowList(['owner/*'], { 'owner/*': { pipeline_source: 'push' } }), /Unknown claim "pipeline_source"/);
  assert.throws(() => parseAllowList(['owner/*'], { 'other/*': { ref: 'refs/heads/main' } }), /not in the allowlist/);
  assert.throws(() => parseAllowList(['owner/*'], { 'owner/*': { ref: [] } }), /non-empty string patterns/);
  const [entry] = parseAllowList(['owner/*'], { 'github:Owner/*': { ref: 'refs/heads/*' } });
  assert.deepEqual(entry.constraints, { ref: ['refs/heads/*'] });
});

test('globMatches treats only * as special', async () => {
  const { globMatches } = await import('../src/allowlist');
  assert.ok(globMatches('owner/repo/.github/workflows/a.yml@refs/heads/main', 'owner/repo/.github/workflows/a.yml@*'));
  assert.ok(!globMatches('owner/repoX/.github/workflows/a.yml@x', 'owner/repo/.github/workflows/a.yml@*'));
  assert.ok(!globMatches('refs/heads/mainX', 'refs/heads/main'));
  assert.ok(!globMatches('aXb', 'a.b'));
});
