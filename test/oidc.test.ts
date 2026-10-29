import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyOidcToken } from '../src/oidc';
import { parseAllowList } from '../src/allowlist';
import { GITHUB_ISSUER, GITLAB_ISSUER } from '../src/issuers';

// One signing key per issuer, served through a stubbed fetch (discovery → JWKS)
const keys = new Map([GITHUB_ISSUER, GITLAB_ISSUER].map((iss) => [iss, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })]));
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    for (const [iss, { publicKey }] of keys) {
      if (url === `${iss}/.well-known/openid-configuration`) return Response.json({ jwks_uri: `${iss}/jwks` });
      if (url === `${iss}/jwks`) return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: iss }] });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

function mint(iss: string, claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: iss });
  const body = b64({ iss, aud: 'agent-gateway', sub: 'x', exp: now + 300, ...claims });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), keys.get(iss)!.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const opts = (allow: string[]) => ({ audience: 'agent-gateway', allow: parseAllowList(allow) });

test('accepts a GitHub token for an allowlisted repo', async () => {
  const claims = await verifyOidcToken(mint(GITHUB_ISSUER, { repository: 'owner/repo' }), opts(['owner/*']));
  assert.equal(claims.repository, 'owner/repo');
});

test('rejects a gitlab.com token for a same-named namespace when only GitHub is allowed', async () => {
  await assert.rejects(
    verifyOidcToken(mint(GITLAB_ISSUER, { project_path: 'owner/repo' }), opts(['owner/*'])),
    /Untrusted issuer/,
  );
});

test('rejects a gitlab.com token for a repo allowed only on GitHub when both issuers are trusted', async () => {
  await assert.rejects(
    verifyOidcToken(mint(GITLAB_ISSUER, { project_path: 'owner/repo' }), opts(['owner/*', 'gitlab:other/*'])),
    /not allowlisted/,
  );
});

test('accepts a gitlab.com token when explicitly allowed', async () => {
  const claims = await verifyOidcToken(mint(GITLAB_ISSUER, { project_path: 'group/sub/proj' }), opts(['gitlab:group/*']));
  assert.equal(claims.project_path, 'group/sub/proj');
});

test('claim constraints narrow an entry to matching refs, events and workflows', async () => {
  const constrained = {
    audience: 'agent-gateway',
    allow: parseAllowList(['owner/repo', 'gitlab:group/*'], {
      'Owner/repo': { event_name: 'pull_request', job_workflow_ref: ['owner/repo/.github/workflows/pr-review.yml@*'] },
      'gitlab:group/*': { pipeline_source: ['merge_request_event'] },
    }),
  };
  const pr = { repository: 'owner/repo', event_name: 'pull_request', job_workflow_ref: 'owner/repo/.github/workflows/pr-review.yml@refs/pull/1/merge' };
  assert.equal((await verifyOidcToken(mint(GITHUB_ISSUER, pr), constrained)).repository, 'owner/repo');
  await assert.rejects(
    verifyOidcToken(mint(GITHUB_ISSUER, { ...pr, event_name: 'push' }), constrained),
    /matches an allow entry but not its claim constraints/,
  );
  await assert.rejects(
    verifyOidcToken(mint(GITHUB_ISSUER, { ...pr, job_workflow_ref: 'owner/repo/.github/workflows/evil.yml@refs/heads/x' }), constrained),
    /claim constraints/,
  );
  // A constrained claim missing from the token never matches
  await assert.rejects(verifyOidcToken(mint(GITLAB_ISSUER, { project_path: 'group/p' }), constrained), /claim constraints/);
  assert.ok(await verifyOidcToken(mint(GITLAB_ISSUER, { project_path: 'group/p', pipeline_source: 'merge_request_event' }), constrained));
});

test('rejections carry a public reason without configuration details', async () => {
  const { OidcError } = await import('../src/oidc');
  const wrongAud = mint(GITHUB_ISSUER, { repository: 'owner/repo' });
  await assert.rejects(verifyOidcToken(wrongAud, { ...opts(['owner/*']), audience: 'private-aud' }), (err: unknown) => {
    assert.ok(err instanceof OidcError);
    assert.equal(err.publicReason, 'Audience mismatch');
    assert.match(err.message, /expected private-aud/);
    return true;
  });
  await assert.rejects(verifyOidcToken(mint(GITHUB_ISSUER, { repository: 'x/y' }), opts(['owner/*'])), (err: unknown) => {
    assert.ok(err instanceof OidcError);
    assert.equal(err.publicReason, 'Repository not allowlisted');
    return true;
  });
});

test('a token whose payload is not base64url JSON is a Malformed JWT', async () => {
  const { OidcError } = await import('../src/oidc');
  await assert.rejects(verifyOidcToken('eyJhbGciOiJSUzI1NiJ9.!!!.sig', opts(['owner/*'])), (err: unknown) => {
    assert.ok(err instanceof OidcError);
    assert.equal(err.publicReason, 'Malformed JWT');
    return true;
  });
});
