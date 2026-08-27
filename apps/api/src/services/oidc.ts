import { createPublicKey, createVerify } from 'node:crypto';
import type { OidcIdentity } from './store.js';

/**
 * OIDC verification for the CI token exchange (§15.2).
 *
 * "Mint the ingest credential via CI OIDC exchange scoped to one `repoId` for ~10 minutes,
 * never a static org secret."
 *
 * The claims that matter are provider-specific but conceptually identical: which repository the
 * workflow belongs to, which ref and commit it ran on. Those are what bind the resulting
 * credential to a scope, and they are what `verifyEnvelope` later checks the asserted bundle
 * scope against.
 */

export interface OidcOptions {
  issuer: string;
  audience: string;
  fetchImpl?: typeof fetch;
  /** JWKS cache lifetime. Providers rotate keys; too long a cache turns a rotation into an outage. */
  jwksTtlMs?: number;
}

interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

/**
 * Why verification failed, because the two kinds belong to different people. A token this
 * deployment rejects is a 401 the runner can act on — wrong audience, expired, wrong issuer.
 * An issuer we could not reach is ours, and nothing the runner can do about it. Collapsing
 * them tells a correctly configured workflow that its credentials are bad.
 */
export type OidcFailure = 'token' | 'issuer';

export class OidcError extends Error {
  constructor(
    message: string,
    readonly failure: OidcFailure = 'token',
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

export class OidcVerifier {
  private readonly fetchImpl: typeof fetch;
  private jwks: { keys: Jwk[]; fetchedAt: number } | null = null;
  private jwksUri: string | null = null;

  constructor(private readonly options: OidcOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async verify(idToken: string, expectedAudience: string): Promise<OidcIdentity> {
    const [headerPart, payloadPart, signaturePart] = idToken.split('.');
    if (!headerPart || !payloadPart || !signaturePart) {
      throw new OidcError('Malformed OIDC token.');
    }

    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
      alg: string;
      kid: string;
    };

    if (header.alg !== 'RS256') {
      // Restricting the algorithm is not pedantry: accepting whatever the token declares is the
      // classic `alg: none` and HMAC-confusion vulnerability.
      throw new OidcError(`Unsupported token algorithm '${header.alg}'. Only RS256 is accepted.`);
    }

    const key = await this.key(header.kid);
    const publicKey = createPublicKey({ key: jwkToPem(key), format: 'pem' });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`);
    if (!verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'))) {
      throw new OidcError('OIDC token signature is invalid.');
    }

    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

    if (claims.iss !== this.options.issuer) {
      throw new OidcError(`Token issuer '${String(claims.iss)}' is not the configured issuer.`);
    }

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expectedAudience)) {
      throw new OidcError(
        `Token audience does not include '${expectedAudience}'. The workflow must request an id-token with this audience.`,
      );
    }

    const exp = Number(claims.exp ?? 0) * 1000;
    if (exp <= Date.now()) throw new OidcError('OIDC token has expired.');

    return {
      issuer: String(claims.iss),
      subject: String(claims.sub ?? ''),
      // GitHub uses `repository`; GitLab uses `project_path`; Azure DevOps varies by config.
      repository: pickString(claims, ['repository', 'project_path', 'repo']),
      ref: pickString(claims, ['ref', 'ref_path', 'branch']),
      sha: pickString(claims, ['sha', 'commit_sha', 'revision']),
    };
  }

  private async key(kid: string): Promise<Jwk> {
    const ttl = this.options.jwksTtlMs ?? 10 * 60 * 1000;

    if (!this.jwks || Date.now() - this.jwks.fetchedAt > ttl) {
      await this.refreshJwks();
    }

    let key = this.jwks?.keys.find((k) => k.kid === kid);
    if (!key) {
      // A key id we have not seen usually means a rotation, not an attack. Refresh once before
      // failing, or every rotation becomes a brief outage for every CI job.
      await this.refreshJwks();
      key = this.jwks?.keys.find((k) => k.kid === kid);
    }

    if (!key) throw new OidcError(`No JWKS key matches kid '${kid}'.`);
    return key;
  }

  private async refreshJwks(): Promise<void> {
    if (!this.jwksUri) {
      const discovery = await this.fetchImpl(
        `${this.options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      );
      if (!discovery.ok) {
        throw new OidcError(`OIDC discovery failed with ${discovery.status}.`, 'issuer');
      }
      const config = (await discovery.json()) as { jwks_uri?: string };
      if (!config.jwks_uri) {
        throw new OidcError('OIDC discovery document has no jwks_uri.', 'issuer');
      }
      this.jwksUri = config.jwks_uri;
    }

    const response = await this.fetchImpl(this.jwksUri);
    if (!response.ok) {
      throw new OidcError(`JWKS fetch failed with ${response.status}.`, 'issuer');
    }
    const body = (await response.json()) as { keys: Jwk[] };
    this.jwks = { keys: body.keys, fetchedAt: Date.now() };
  }
}

/** Minimal RSA JWK → PEM. Avoids a dependency for a well-specified 40-line transform. */
function jwkToPem(jwk: Jwk): string {
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new OidcError(`Unsupported JWK type '${jwk.kty}'.`);
  }

  const modulus = base64UrlToBuffer(jwk.n);
  const exponent = base64UrlToBuffer(jwk.e);

  const rsaPublicKey = derSequence([derInteger(modulus), derInteger(exponent)]);
  const algorithm = derSequence([derOid('1.2.840.113549.1.1.1'), Buffer.from([0x05, 0x00])]);
  const subjectPublicKeyInfo = derSequence([algorithm, derBitString(rsaPublicKey)]);

  const base64 = subjectPublicKeyInfo.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----\n`;
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derSequence(parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
}

function derInteger(value: Buffer): Buffer {
  // Leading zero when the high bit is set, so the value is not read as negative.
  const body = value[0]! & 0x80 ? Buffer.concat([Buffer.from([0x00]), value]) : value;
  return Buffer.concat([Buffer.from([0x02]), derLength(body.length), body]);
}

function derBitString(value: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([0x00]), value]);
  return Buffer.concat([Buffer.from([0x03]), derLength(body.length), body]);
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunks: number[] = [];
    let value = part;
    do {
      chunks.unshift(value & 0x7f);
      value >>= 7;
    } while (value > 0);
    for (let i = 0; i < chunks.length - 1; i++) chunks[i]! |= 0x80;
    bytes.push(...chunks);
  }
  return Buffer.concat([Buffer.from([0x06]), derLength(bytes.length), Buffer.from(bytes)]);
}

function pickString(claims: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}
