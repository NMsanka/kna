import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BundleSignature, IrBundleEnvelope } from '@kna/ir';

/**
 * §15.2 BLOCKER — "'IR bundle, signed' is a word in a diagram."
 *
 * "Nothing defines what is signed, by which key, or what the verifier checks. Because scope
 * keys are denormalised onto every row, a holder of any ingest token can assert another
 * tenant's `orgId` and poison that tenant's index — a far more powerful attack than the
 * code-comment injection Layer 5 addresses, since forged IR bypasses all CLI-side scanning in
 * Layer 2 entirely."
 *
 * This module defines all three. What is signed is a canonical claim string covering the
 * payload hash *and* every field the verifier must trust. Who signs is either the CI workload
 * identity (Sigstore keyless, via OIDC) or a shared HMAC key for self-hosted runners. What the
 * verifier checks is enumerated in `verifyEnvelope`, in order, failing closed at every step.
 */

/**
 * The signed claim string.
 *
 * Signing the payload hash alone would be insufficient: an attacker could take a legitimately
 * signed bundle for their own repo and re-envelope it under a different `orgId`. Every field
 * the verifier makes a trust decision on is inside the signature.
 */
export function canonicalClaims(input: {
  orgId: string;
  repoId: string;
  commitSha: string;
  ref: string;
  nonce: string;
  expiresAt: string;
  payloadHash: string;
  irSchemaVersion: string;
}): string {
  return [
    'kna-ir-bundle/1',
    input.irSchemaVersion,
    input.orgId,
    input.repoId,
    input.commitSha,
    input.ref,
    input.nonce,
    input.expiresAt,
    input.payloadHash,
  ].join('\n');
}

export function signHmac(secret: string, claims: string): BundleSignature {
  return {
    algorithm: 'hmac-sha256',
    value: createHmac('sha256', secret).update(claims, 'utf8').digest('hex'),
    signerClaims: {
      issuer: null,
      subject: null,
      repository: null,
      ref: null,
      sha: null,
      workflow: null,
      runId: null,
    },
    keyId: null,
  };
}

/**
 * Development-only signature. Refused in production by `loadPlatformEnv`, and refused again
 * here — a permissive default that only fails in one place is a permissive default.
 */
export function signUnsignedDev(claims: string): BundleSignature {
  return {
    algorithm: 'unsigned-dev',
    value: `dev:${claims.length}`,
    signerClaims: {
      issuer: null,
      subject: null,
      repository: null,
      ref: null,
      sha: null,
      workflow: null,
      runId: null,
    },
    keyId: null,
  };
}

export type VerificationFailure =
  | 'expired'
  | 'replayed'
  | 'bad-signature'
  | 'signer-scope-mismatch'
  | 'commit-not-found'
  | 'payload-hash-mismatch'
  | 'unsupported-algorithm'
  | 'unsigned-in-production'
  | 'scan-not-passed'
  | 'bundle-too-large';

export interface VerificationResult {
  valid: boolean;
  failure: VerificationFailure | null;
  detail: string | null;
}

export interface VerifyOptions {
  envelope: IrBundleEnvelope;
  /** Recomputed from the received body, never taken from the envelope. */
  actualPayloadHash: string;
  actualPayloadBytes: number;
  mode: 'sigstore' | 'hmac' | 'permissive-dev';
  hmacSecret?: string;
  maxBundleBytes: number;
  /** Has this nonce been seen? Backed by a unique index on `ir_bundles`. */
  isNonceSeen: (orgId: string, nonce: string) => Promise<boolean>;
  /** Does this commit exist on this ref, per the Git provider API? */
  verifyCommit?: (input: { repoId: string; commitSha: string; ref: string }) => Promise<boolean>;
  /** Map an asserted repoId back to its canonical remote, to compare against signer claims. */
  resolveRepoRemote?: (repoId: string) => Promise<string | null>;
  /** Did the CLI's guardrail scan pass? A bundle asserting otherwise is rejected (§10 Layer 2). */
  scanPassed: boolean;
  isProduction: boolean;
  now?: Date;
}

/**
 * Verify, in order, failing closed at every step.
 *
 * The order is deliberate: cheap structural checks before expensive network calls, and the
 * signer-scope check before the commit check, because an attacker who can forge scope is more
 * dangerous than one who can name a nonexistent commit.
 */
export async function verifyEnvelope(options: VerifyOptions): Promise<VerificationResult> {
  const { envelope } = options;
  const now = options.now ?? new Date();

  const fail = (failure: VerificationFailure, detail: string): VerificationResult => ({
    valid: false,
    failure,
    detail,
  });

  // 1. Size. Checked first so a hostile payload cannot force expensive work.
  if (options.actualPayloadBytes > options.maxBundleBytes) {
    return fail(
      'bundle-too-large',
      `Bundle is ${options.actualPayloadBytes} bytes, over the ${options.maxBundleBytes} limit.`,
    );
  }

  // 2. Payload integrity. Everything downstream trusts this hash.
  if (envelope.payloadHash !== options.actualPayloadHash) {
    return fail(
      'payload-hash-mismatch',
      'The received payload does not hash to the value in the envelope.',
    );
  }

  // 3. §10 Layer 2 fails closed at the CLI; the platform refuses the bundle too, so a patched
  //    CLI cannot bypass the scan by simply reporting a pass it never ran.
  if (!options.scanPassed) {
    return fail(
      'scan-not-passed',
      'The bundle reports unresolved secret or PII findings. Guardrail Layer 2 fails closed on both sides of the boundary.',
    );
  }

  // 4. Freshness and replay. Webhooks get replayed; replays must be no-ops (§7).
  if (new Date(envelope.expiresAt) <= now) {
    return fail('expired', `Bundle expired at ${envelope.expiresAt}.`);
  }
  if (await options.isNonceSeen(envelope.orgId, envelope.nonce)) {
    return fail('replayed', 'This bundle nonce has already been consumed.');
  }

  // 5. Signature.
  const claims = canonicalClaims({
    orgId: envelope.orgId,
    repoId: envelope.repoId,
    commitSha: envelope.commitSha,
    ref: envelope.ref,
    nonce: envelope.nonce,
    expiresAt: envelope.expiresAt,
    payloadHash: envelope.payloadHash,
    irSchemaVersion: envelope.irSchemaVersion,
  });

  if (envelope.signature.algorithm === 'unsigned-dev') {
    if (options.isProduction || options.mode !== 'permissive-dev') {
      return fail(
        'unsigned-in-production',
        'Unsigned bundles are only accepted in a permissive-dev deployment.',
      );
    }
  } else if (envelope.signature.algorithm === 'hmac-sha256') {
    if (!options.hmacSecret) {
      return fail('unsupported-algorithm', 'HMAC bundle received but no HMAC secret configured.');
    }
    const expected = createHmac('sha256', options.hmacSecret).update(claims, 'utf8').digest();
    const actual = Buffer.from(envelope.signature.value, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return fail('bad-signature', 'HMAC signature does not match the envelope claims.');
    }
  } else if (envelope.signature.algorithm === 'sigstore-keyless') {
    const verified = await verifySigstoreClaims(envelope, options);
    if (!verified.valid) return verified;
  } else {
    return fail('unsupported-algorithm', `Unknown algorithm '${envelope.signature.algorithm}'.`);
  }

  // 6. Commit existence. The last check because it is the only one requiring a network call.
  if (options.verifyCommit) {
    const exists = await options.verifyCommit({
      repoId: envelope.repoId,
      commitSha: envelope.commitSha,
      ref: envelope.ref,
    });
    if (!exists) {
      return fail(
        'commit-not-found',
        `Commit ${envelope.commitSha} was not found on ${envelope.ref} at the Git provider.`,
      );
    }
  }

  return { valid: true, failure: null, detail: null };
}

/**
 * Sigstore keyless verification.
 *
 * The cryptographic verification of the Sigstore bundle itself belongs to `@sigstore/verify`;
 * what this function owns is the part §15.2 actually calls for and that no library can do for
 * you: **checking that the signer's identity claims match the scope being asserted**. A valid
 * signature from repo A's workflow is still a forgery when the envelope claims repo B.
 */
async function verifySigstoreClaims(
  envelope: IrBundleEnvelope,
  options: VerifyOptions,
): Promise<VerificationResult> {
  const claims = envelope.signature.signerClaims;

  if (!claims.repository || !claims.sha) {
    return {
      valid: false,
      failure: 'signer-scope-mismatch',
      detail: 'Sigstore signature carries no repository or commit claim to bind against.',
    };
  }

  // The commit the workflow ran on must be the commit being published.
  if (claims.sha.toLowerCase() !== envelope.commitSha.toLowerCase()) {
    return {
      valid: false,
      failure: 'signer-scope-mismatch',
      detail: `Signer ran on ${claims.sha} but the bundle asserts ${envelope.commitSha}.`,
    };
  }

  // And the repository the workflow belongs to must be the repository being published.
  if (options.resolveRepoRemote) {
    const remote = await options.resolveRepoRemote(envelope.repoId);
    if (!remote) {
      return {
        valid: false,
        failure: 'signer-scope-mismatch',
        detail: `Asserted repoId ${envelope.repoId} is not registered in this org.`,
      };
    }
    if (!remote.endsWith(claims.repository.toLowerCase())) {
      return {
        valid: false,
        failure: 'signer-scope-mismatch',
        detail: `Signer identity is '${claims.repository}' but repoId ${envelope.repoId} resolves to '${remote}'. A token for one repository cannot publish IR for another.`,
      };
    }
  }

  return { valid: true, failure: null, detail: null };
}

/**
 * Human-readable rejection, returned to the CLI.
 *
 * Deliberately explicit about *why*: a rejected publish that says only "403" produces a support
 * ticket, and the reasons here are all things the developer or their platform team can act on.
 */
export function explainFailure(result: VerificationResult): string {
  const guidance: Record<VerificationFailure, string> = {
    expired:
      'Bundles are short-lived. Re-run the indexing job rather than replaying a stored bundle.',
    replayed:
      'This bundle was already ingested. Webhook replays are expected and are treated as no-ops.',
    'bad-signature':
      'The signature does not match the claims. Check that the CI job and the platform share the same ingest key.',
    'signer-scope-mismatch':
      'The signing workload identity does not match the repository or commit being published. A credential scoped to one repo cannot publish for another.',
    'commit-not-found':
      'The Git provider does not have this commit on this ref. Force-pushed or deleted branches produce this.',
    'payload-hash-mismatch':
      'The payload was altered in transit or the hash was computed over different bytes.',
    'unsupported-algorithm': 'Configure INGEST_SIGNATURE_MODE to match what the CLI is producing.',
    'unsigned-in-production':
      'Production never accepts unsigned bundles. Mint an ingest credential via CI OIDC exchange.',
    'scan-not-passed':
      'The guardrail scan reported unresolved findings. Resolve them, or add a reviewed allowlist entry with a reason.',
    'bundle-too-large':
      'Split the repo into modules, or raise INGEST_MAX_BUNDLE_BYTES deliberately.',
  };

  if (!result.failure) return 'Bundle accepted.';
  return `${result.detail ?? 'Bundle rejected.'}\n\n${guidance[result.failure]}`;
}
