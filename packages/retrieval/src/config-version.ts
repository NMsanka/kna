import { createHash } from 'node:crypto';

/**
 * §15.5 BLOCKER — "Nothing defines what a retrieval 'change' is, and there is no gate."
 *
 * "Chunking strategy, blurb prompt and model, embedding model, RRF constant, reranker, top-k,
 * graph-expansion depth and the system prompt all move quality independently. Hash them into
 * one `retrieval_config_version`, stamp it on every chunk and every query trace, gate merges on
 * a CI eval reporting per-stratum deltas with confidence intervals."
 *
 * Every knob that can move retrieval quality is enumerated here. If a change to the pipeline
 * does not change this hash, that is a bug in this file — not a licence to skip the eval.
 */

export interface RetrievalConfig {
  // ── Index-time ───────────────────────────────────────────────────────────────────────────
  chunkStrategy: string;
  chunkMaxTokens: number;
  chunkOverlapTokens: number;
  blurbPromptVersion: string;
  blurbModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  dedupeThreshold: number;

  // ── Query-time ───────────────────────────────────────────────────────────────────────────
  rrfK: number;
  topKDense: number;
  topKLexical: number;
  topKSymbol: number;
  topNFinal: number;
  rerankerModel: string | null;
  mmrLambda: number;
  maxPerModule: number;
  generatedPenalty: number;
  efSearch: number;

  // ── Expansion and budget ─────────────────────────────────────────────────────────────────
  expansionMaxPerSeed: number;
  expansionCentralityCeiling: number;
  contextTotalTokens: number;
  contextPrimaryFraction: number;
  contextExpansionFraction: number;

  // ── Generation ───────────────────────────────────────────────────────────────────────────
  chatModel: string;
  systemPromptVersion: string;
  abstentionThreshold: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  chunkStrategy: 'ast-symbol-v1',
  chunkMaxTokens: 1_200,
  chunkOverlapTokens: 80,
  blurbPromptVersion: '1.0.0',
  blurbModel: 'gpt-4.1-mini',
  embeddingModel: 'text-embedding-3-large',
  embeddingDimensions: 1024,
  dedupeThreshold: 3,

  rrfK: 60,
  topKDense: 50,
  topKLexical: 50,
  topKSymbol: 10,
  topNFinal: 8,
  rerankerModel: null,
  mmrLambda: 0.7,
  maxPerModule: 3,
  generatedPenalty: 0.25,
  efSearch: 100,

  expansionMaxPerSeed: 4,
  expansionCentralityCeiling: 50,
  contextTotalTokens: 24_000,
  contextPrimaryFraction: 0.55,
  contextExpansionFraction: 0.25,

  chatModel: 'gpt-4.1',
  systemPromptVersion: '1.0.0',
  abstentionThreshold: 0.35,
};

/**
 * The version stamp.
 *
 * Split into two halves deliberately. An index-time change requires a reindex before the eval
 * means anything; a query-time change does not. Reporting them separately is what lets the CI
 * gate say "this is a cheap experiment" versus "this needs a backfill first".
 */
export function computeConfigVersion(config: RetrievalConfig): {
  version: string;
  indexVersion: string;
  queryVersion: string;
} {
  const indexKeys: (keyof RetrievalConfig)[] = [
    'chunkStrategy',
    'chunkMaxTokens',
    'chunkOverlapTokens',
    'blurbPromptVersion',
    'blurbModel',
    'embeddingModel',
    'embeddingDimensions',
    'dedupeThreshold',
  ];

  const indexVersion = hashSubset(config, indexKeys);
  const queryVersion = hashSubset(
    config,
    (Object.keys(config) as (keyof RetrievalConfig)[]).filter((k) => !indexKeys.includes(k)),
  );

  return {
    version: `${indexVersion}.${queryVersion}`,
    indexVersion,
    queryVersion,
  };
}

function hashSubset(config: RetrievalConfig, keys: (keyof RetrievalConfig)[]): string {
  const canonical = [...keys]
    .sort()
    .map((key) => `${key}=${String(config[key])}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/**
 * Compare two configs and say what a change costs.
 *
 * Answers the question a reviewer actually has on a config-change PR: can this ship behind a
 * flag, or does it need a full backfill first?
 */
export interface ConfigDiff {
  changed: Array<{ key: keyof RetrievalConfig; from: unknown; to: unknown }>;
  requiresReindex: boolean;
  requiresBackfill: boolean;
  summary: string;
}

export function diffConfig(before: RetrievalConfig, after: RetrievalConfig): ConfigDiff {
  const changed: ConfigDiff['changed'] = [];
  for (const key of Object.keys(after) as (keyof RetrievalConfig)[]) {
    if (before[key] !== after[key]) changed.push({ key, from: before[key], to: after[key] });
  }

  const beforeVersion = computeConfigVersion(before);
  const afterVersion = computeConfigVersion(after);
  const requiresReindex = beforeVersion.indexVersion !== afterVersion.indexVersion;
  const requiresBackfill =
    before.embeddingModel !== after.embeddingModel ||
    before.embeddingDimensions !== after.embeddingDimensions;

  const lines = changed.map((c) => `  ${String(c.key)}: ${String(c.from)} → ${String(c.to)}`);

  if (requiresBackfill) {
    lines.push('');
    lines.push(
      'This changes the embedding space. Two embedding spaces are not comparable and cannot be',
    );
    lines.push('fused, so this needs the migration runbook: separate partition per model,');
    lines.push('throttled backfill, a read path pinned to one model, then percentage cutover.');
    lines.push('See docs/runbooks/embedding-migration.md.');
  } else if (requiresReindex) {
    lines.push('');
    lines.push('This changes how chunks are built. Existing chunks must be rebuilt before an');
    lines.push('eval on this config means anything.');
  }

  return {
    changed,
    requiresReindex,
    requiresBackfill,
    summary: lines.join('\n') || '  (no changes)',
  };
}
