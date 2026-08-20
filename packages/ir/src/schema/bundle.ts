import { z } from 'zod';
import { zModule } from './module.js';
import { zSymbol } from './symbol.js';
import { zRepoRef, zVersionRef } from './repo.js';
import { zAnalysisDepth, zLanguage } from './primitives.js';

/** Raw Tier 2 artefacts carried alongside the symbols. */
export const zApiSpec = z.object({
  specId: z.string(),
  moduleId: z.string(),
  title: z.string(),
  version: z.string(),
  format: z.enum(['openapi3', 'openapi31', 'swagger2', 'asyncapi', 'graphql', 'grpc']),
  /** The document itself, stored verbatim: it is the customer-facing source of truth. */
  document: z.unknown(),
  documentHash: z.string(),
  sourcePath: z.string().nullable().default(null),
});
export type ApiSpec = z.infer<typeof zApiSpec>;

/** Deployment topology harvested from IaC, compose files and Helm charts (§5 Tier 2). */
export const zServiceManifest = z.object({
  name: z.string(),
  kind: z.enum(['service', 'database', 'queue', 'cache', 'external', 'job']),
  moduleId: z.string().nullable().default(null),
  image: z.string().nullable().default(null),
  dependsOn: z.array(z.string()).default([]),
  ports: z.array(z.number().int()).default([]),
  source: z.string().describe('Path of the manifest it came from'),
});

/** What the CLI could and could not do — powers the "why is my repo shallow?" diagnostic. */
export const zToolchainReport = z.object({
  detected: z.record(z.string(), z.string().nullable()).default({}),
  tiersRun: z.array(z.enum(['tier0', 'tier1', 'tier2'])).default([]),
  degradations: z
    .array(z.object({ module: z.string(), reason: z.string(), missing: z.string().nullable() }))
    .default([]),
  durationMs: z.number().int().nonnegative().default(0),
});

/** §10 Layer 2 — the scan ran, and it is recorded that it ran. Fail closed means findings > 0
 *  never reach here; a bundle with findings is rejected at ingest as well as at publish. */
export const zScanReport = z.object({
  scannerVersion: z.string(),
  rulesetHash: z.string(),
  filesScanned: z.number().int().nonnegative(),
  secretsFound: z.number().int().nonnegative().default(0),
  piiFound: z.number().int().nonnegative().default(0),
  pathsExcluded: z.number().int().nonnegative().default(0),
  injectionPatternsFlagged: z.number().int().nonnegative().default(0),
  passed: z.boolean(),
});

export const zIrBundlePayload = z.object({
  repo: zRepoRef,
  version: zVersionRef,
  modules: z.array(zModule),
  symbols: z.array(zSymbol),
  apiSpecs: z.array(zApiSpec).default([]),
  services: z.array(zServiceManifest).default([]),
  languages: z.array(zLanguage).default([]),
  analysisDepth: zAnalysisDepth,
  toolchain: zToolchainReport,
  scan: zScanReport,
  /** True when the repo opted in to snippet upload; changes the ingest handling of sourceText. */
  includesSource: z.boolean().default(false),
  generatedAt: z.string().datetime(),
});
export type IrBundlePayload = z.infer<typeof zIrBundlePayload>;

/**
 * §15.2 BLOCKER — "'IR bundle, signed' is a word in a diagram".
 *
 * This envelope makes it concrete. What is signed: the sha256 of the canonical payload plus
 * every field the verifier must trust (orgId, repoId, commitSha, nonce, expiry). Who signs:
 * the CI workload identity via Sigstore keyless, or an HMAC key for self-hosted runners.
 * What the verifier checks, in order:
 *
 *   1. Envelope schema and IR version inside the N-2 window.
 *   2. `expiresAt` in the future and `nonce` unseen — bundles are not replayable.
 *   3. Signature valid over `payloadHash` + envelope claims.
 *   4. Signer identity claims (OIDC `repository`, `sha`, `ref`) match the *asserted* repoId
 *      and commitSha. A token for repo A cannot publish IR for repo B.
 *   5. `commitSha` exists on the asserted ref, checked against the Git provider API.
 *   6. `payloadHash` recomputed from the received body.
 *
 * Steps 4 and 5 are what stop a holder of any ingest token asserting another tenant's orgId
 * and poisoning that tenant's index — the attack §15.2 rates above comment injection, because
 * forged IR bypasses all CLI-side scanning in Layer 2 entirely.
 */
export const zBundleSignature = z.object({
  algorithm: z.enum(['sigstore-keyless', 'hmac-sha256', 'ed25519', 'unsigned-dev']),
  /** Sigstore bundle, HMAC digest, or detached signature — algorithm-dependent. */
  value: z.string(),
  /** Certificate identity claims the verifier matches against the asserted scope. */
  signerClaims: z
    .object({
      issuer: z.string().nullable().default(null),
      subject: z.string().nullable().default(null),
      repository: z.string().nullable().default(null),
      ref: z.string().nullable().default(null),
      sha: z.string().nullable().default(null),
      workflow: z.string().nullable().default(null),
      runId: z.string().nullable().default(null),
    })
    .default({}),
  keyId: z.string().nullable().default(null),
});
export type BundleSignature = z.infer<typeof zBundleSignature>;

export const zIrBundleEnvelope = z.object({
  irSchemaVersion: z.string(),
  bundleId: z.string().uuid(),
  orgId: z.string(),
  repoId: z.string(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  ref: z.string(),
  /** Single-use. Replayed webhooks must be no-ops (§7 idempotency). */
  nonce: z.string().min(16),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  producer: z.object({
    name: z.string().default('docs-cli'),
    version: z.string(),
    environment: z.enum(['ci', 'local', 'replay']),
  }),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  payloadBytes: z.number().int().positive(),
  /** Object-storage key of the immutable bundle — §15.1 fix 1, IR bundles are the system of
   *  record and Postgres is an explicitly derived cache. Set by the ingest API on receipt. */
  storageKey: z.string().nullable().default(null),
  signature: zBundleSignature,
});
export type IrBundleEnvelope = z.infer<typeof zIrBundleEnvelope>;

export const zIrBundle = z.object({
  envelope: zIrBundleEnvelope,
  payload: zIrBundlePayload,
});
export type IrBundle = z.infer<typeof zIrBundle>;
