import type { Sensitivity } from '@kna/ir';

/**
 * §10 Layer 3 — sensitivity classification.
 *
 * Derived from repo config, path patterns, and CODEOWNERS. Two rules make this safe:
 *
 *  - Classification may only ever *raise* the tier automatically. Lowering it — in particular
 *    promoting anything to `public` — is an explicit human-reviewed event (§15.7: "promotion
 *    to the public tier is a one-way door"), because one bad glob publishes internal API
 *    surface to integration partners, already embedded and cached.
 *  - `restricted` is excluded from the embedding pipeline entirely. The safest chunk is the
 *    one that was never vectorised.
 */

const RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export interface ClassificationRule {
  pattern: RegExp;
  tier: Sensitivity;
  reason: string;
}

/** Built-in heuristics. Conservative: they raise, never lower. */
export const DEFAULT_CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    pattern: /(^|\/)(payments?|billing|invoicing|checkout)(\/|$)/i,
    tier: 'confidential',
    reason: 'payment-handling path',
  },
  {
    pattern: /(^|\/)(security|auth|authn|authz|identity|crypto|kms)(\/|$)/i,
    tier: 'confidential',
    reason: 'security-critical path',
  },
  {
    pattern: /(^|\/)(compliance|legal|hr|payroll|pii)(\/|$)/i,
    tier: 'restricted',
    reason: 'regulated-data path',
  },
  {
    pattern: /(^|\/)(infra|terraform|helm|k8s|deploy)(\/|$)/i,
    tier: 'confidential',
    reason: 'deployment topology',
  },
  {
    pattern: /(^|\/)(examples?|samples?|docs?|public-api|sdk)(\/|$)/i,
    // Note this is `internal`, not `public`. Nothing becomes public by inference.
    tier: 'internal',
    reason: 'example or documentation path',
  },
];

export interface ClassifyInput {
  path: string;
  /** Tier from the repo's own config, if it named one for this path. */
  configuredTier?: Sensitivity | null;
  /** Repo-wide default from config. */
  repoDefault: Sensitivity;
  rules?: ClassificationRule[];
  /** Attributes/decorators observed on symbols in this module, e.g. `[Sensitive]`. */
  codeMarkers?: string[];
}

export interface Classification {
  tier: Sensitivity;
  reasons: string[];
  /** True when only an explicit human decision could produce this tier. */
  requiresReviewToPublishExternally: boolean;
}

const SENSITIVE_MARKERS = /^(sensitive|confidential|restricted|internalonly|pii)$/i;

export function classify(input: ClassifyInput): Classification {
  const reasons: string[] = [];
  let tier: Sensitivity = input.repoDefault;
  reasons.push(`repo default: ${input.repoDefault}`);

  for (const rule of input.rules ?? DEFAULT_CLASSIFICATION_RULES) {
    if (!rule.pattern.test(input.path)) continue;
    if (RANK[rule.tier] > RANK[tier]) {
      tier = rule.tier;
      reasons.push(`raised to ${rule.tier}: ${rule.reason}`);
    }
  }

  for (const marker of input.codeMarkers ?? []) {
    if (SENSITIVE_MARKERS.test(marker.replace(/[[\]()@]/g, ''))) {
      if (RANK.confidential > RANK[tier]) {
        tier = 'confidential';
        reasons.push(`raised to confidential: code marker ${marker}`);
      }
    }
  }

  // Config is authoritative in the raising direction, and may lower only to `internal` or
  // above. `public` is never reachable from configuration alone.
  if (input.configuredTier) {
    if (RANK[input.configuredTier] > RANK[tier]) {
      tier = input.configuredTier;
      reasons.push(`raised to ${input.configuredTier}: repo configuration`);
    } else if (input.configuredTier === 'public') {
      reasons.push(
        'repo configuration requests public; withheld pending explicit external-publication review',
      );
    } else if (RANK[input.configuredTier] < RANK[tier]) {
      reasons.push(
        `repo configuration requests ${input.configuredTier}, lower than the derived ${tier}; keeping the higher tier`,
      );
    }
  }

  return {
    tier,
    reasons,
    requiresReviewToPublishExternally: true,
  };
}

/** §10 Layer 3 — `restricted` content never enters the embedding pipeline. */
export function isEmbeddable(tier: Sensitivity): boolean {
  return tier !== 'restricted';
}

/** A caller with clearance `clearance` may see content at or below their tier. */
export function isVisibleTo(contentTier: Sensitivity, clearance: Sensitivity): boolean {
  return RANK[contentTier] <= RANK[clearance];
}
