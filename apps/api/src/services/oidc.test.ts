import { describe, expect, it } from 'vitest';
import { OidcError, OidcVerifier } from './oidc.js';

/**
 * What these pin is the *kind* of each failure, not the wording.
 *
 * `/v1/auth/ci-exchange` maps `failure` straight onto a status code: a token this deployment
 * rejects is a 401 the runner can act on, and an issuer we could not reach is a 502 that is ours.
 * Get that mapping backwards and a correctly configured workflow is told its credentials are bad,
 * which is the one diagnosis that sends someone to regenerate a credential that was fine.
 *
 * Before this, every one of these escaped the route uncaught and became the same 500 — on the one
 * endpoint whose caller is a workflow that cannot read our logs.
 */

const ISSUER = 'https://token.actions.githubusercontent.com';

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A syntactically complete token. The signature is nonsense — none of these get that far. */
function token(header: object, claims: object): string {
  return `${b64(header)}.${b64(claims)}.${Buffer.from('not-a-signature').toString('base64url')}`;
}

function verifier(fetchImpl: typeof fetch): OidcVerifier {
  return new OidcVerifier({ issuer: ISSUER, audience: 'kna-ingest', fetchImpl });
}

/** Answers discovery and JWKS, so a test reaches claim checking rather than stopping at the network. */
const reachable = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith('/.well-known/openid-configuration')) {
    return new Response(JSON.stringify({ jwks_uri: `${ISSUER}/.well-known/jwks` }), {
      status: 200,
    });
  }
  return new Response(JSON.stringify({ keys: [] }), { status: 200 });
}) as typeof fetch;

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OidcError) return error.failure;
    throw error;
  }
  throw new Error('expected an OidcError');
}

describe('OidcVerifier', () => {
  describe("the caller's fault — a 401", () => {
    it('a token that is not a JWT', async () => {
      const v = verifier(reachable);
      expect(await failureOf(v.verify('not-a-token', 'kna-ingest'))).toBe('token');
    });

    it('an algorithm other than RS256', async () => {
      // Accepting whatever the token declares is the `alg: none` and HMAC-confusion hole, so this
      // is refused before any key is fetched.
      const v = verifier(reachable);
      const t = token({ alg: 'none', kid: 'k' }, { iss: ISSUER });
      expect(await failureOf(v.verify(t, 'kna-ingest'))).toBe('token');
    });

    it('a structurally valid token whose segments are not JSON', async () => {
      // `a.b.c` has three parts, so it passes the shape check and then reached an unguarded
      // JSON.parse. SyntaxError is not an OidcError, so it escaped the route as a 500 — the
      // failure the typed error exists to prevent, one line past the check for it.
      const v = verifier(reachable);
      expect(await failureOf(v.verify('a.b.c', 'kna-ingest'))).toBe('token');
    });

    it('a key id the issuer does not publish', async () => {
      const v = verifier(reachable);
      const t = token({ alg: 'RS256', kid: 'rotated-away' }, { iss: ISSUER });
      expect(await failureOf(v.verify(t, 'kna-ingest'))).toBe('token');
    });
  });

  describe('ours — a 502', () => {
    it('discovery that does not answer', async () => {
      const v = verifier((async () => new Response('nope', { status: 503 })) as typeof fetch);
      const t = token({ alg: 'RS256', kid: 'k' }, { iss: ISSUER });
      expect(await failureOf(v.verify(t, 'kna-ingest'))).toBe('issuer');
    });

    it('a discovery document with no jwks_uri', async () => {
      const v = verifier((async () => new Response('{}', { status: 200 })) as typeof fetch);
      const t = token({ alg: 'RS256', kid: 'k' }, { iss: ISSUER });
      expect(await failureOf(v.verify(t, 'kna-ingest'))).toBe('issuer');
    });

    it('a JWKS endpoint that does not answer', async () => {
      const v = verifier((async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration')) {
          return new Response(JSON.stringify({ jwks_uri: `${ISSUER}/keys` }), { status: 200 });
        }
        return new Response('nope', { status: 500 });
      }) as typeof fetch);
      const t = token({ alg: 'RS256', kid: 'k' }, { iss: ISSUER });
      expect(await failureOf(v.verify(t, 'kna-ingest'))).toBe('issuer');
    });
  });

  it('defaults to blaming the token, not the issuer', async () => {
    // A new throw site added without thinking about this should read as the caller's problem.
    // Answering 502 to a bad token tells a runner to retry something that will never succeed.
    expect(new OidcError('anything').failure).toBe('token');
  });
});
