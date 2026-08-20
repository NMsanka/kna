import { sql } from 'drizzle-orm';
import { setEfSearch, withOrgContext, type DbHandle } from '@kna/db';
import { buildAclPredicate } from './acl.js';
import type { AccessContext, CandidateRef, RetrievalScope, ScoredChunk } from './types.js';
import type { GraphNeighbour } from './expansion.js';

/**
 * The three retrieval arms, as SQL.
 *
 * §8 — "Pure dense retrieval fails badly on code... Hybrid is mandatory." All three arms share
 * one ACL predicate, built once and interpolated into each query, so there is no path where one
 * arm is filtered and another is not.
 *
 * The queries are hand-written rather than composed through the ORM because the vector operator,
 * the tsvector rank, and the `ef_search` session setting all need precise placement, and
 * because a reviewer auditing the ACL filter should be able to read the actual SQL.
 */

export interface SearchOptions {
  scope: RetrievalScope;
  access: AccessContext;
  embeddingModel: string;
  efSearch: number;
  corpora?: string[];
}

export class RetrievalStore {
  constructor(private readonly handle: DbHandle) {}

  /** Dense arm: pgvector cosine over the model-pinned partition. */
  async denseSearch(
    queryVector: number[],
    limit: number,
    options: SearchOptions,
  ): Promise<CandidateRef[]> {
    const acl = buildAclPredicate(options.access, options.scope);
    const corpora = options.corpora ?? [];
    const vector = `[${queryVector.join(',')}]`;

    return withOrgContext(this.handle, options.access.orgId, async (tx) => {
      await setEfSearch(tx, options.efSearch);

      const rows = await tx.execute<{ chunk_id: string; distance: number }>(sql`
        SELECT c.id AS chunk_id,
               (e.embedding <=> ${vector}::halfvec) AS distance
        FROM chunks c
        JOIN embeddings e
          ON e.chunk_id = c.id
         -- Pinned to exactly one embedding model per query. Fusing across spaces is
         -- meaningless, and this is the join condition that makes it impossible.
         AND e.model = ${options.embeddingModel}
        WHERE ${acl}
          ${corpora.length ? sql`AND c.corpus = ANY(${corpora})` : sql``}
        ORDER BY e.embedding <=> ${vector}::halfvec
        LIMIT ${limit}
      `);

      return rows.map((row, index) => ({
        chunkId: row.chunk_id,
        rank: index + 1,
        // Cosine distance → similarity, for readability in traces.
        score: 1 - Number(row.distance),
      }));
    });
  }

  /**
   * Lexical arm.
   *
   * §15.5 MEDIUM notes `ts_rank` is not BM25 — no true corpus IDF. Two compensations: the
   * `simple` configuration (no stemming, so identifiers match themselves), and a blend with
   * trigram similarity, which catches the substring case tsvector structurally cannot.
   */
  async lexicalSearch(
    query: string,
    limit: number,
    options: SearchOptions,
  ): Promise<CandidateRef[]> {
    const acl = buildAclPredicate(options.access, options.scope);
    const corpora = options.corpora ?? [];

    return withOrgContext(this.handle, options.access.orgId, async (tx) => {
      const rows = await tx.execute<{ chunk_id: string; score: number }>(sql`
        WITH q AS (SELECT plainto_tsquery('simple', ${query}) AS tsq)
        SELECT c.id AS chunk_id,
               (
                 ts_rank_cd(c.content_tsv, q.tsq)
                 + 0.3 * similarity(c.content, ${query})
               ) AS score
        FROM chunks c, q
        WHERE ${acl}
          AND (c.content_tsv @@ q.tsq OR c.content % ${query})
          ${corpora.length ? sql`AND c.corpus = ANY(${corpora})` : sql``}
        ORDER BY score DESC
        LIMIT ${limit}
      `);

      return rows.map((row, index) => ({
        chunkId: row.chunk_id,
        rank: index + 1,
        score: Number(row.score),
      }));
    });
  }

  /**
   * Exact-identifier arm — a direct IR lookup, not a search.
   *
   * §8 gives this its own arm for a reason: "when a developer asks 'what does
   * getUserByTenantId do', they want exact lexical matching on that identifier". This resolves
   * the name against the symbol table and returns that symbol's chunks, so an exact hit cannot
   * be outranked by five semantically similar wrong functions.
   */
  async symbolSearch(
    identifiers: string[],
    limit: number,
    options: SearchOptions,
  ): Promise<CandidateRef[]> {
    if (identifiers.length === 0) return [];
    const acl = buildAclPredicate(options.access, options.scope);
    const lowered = identifiers.map((i) => i.toLowerCase());

    return withOrgContext(this.handle, options.access.orgId, async (tx) => {
      const rows = await tx.execute<{ chunk_id: string; exactness: number }>(sql`
        SELECT c.id AS chunk_id,
               CASE
                 WHEN lower(s.name) = ANY(${lowered}) THEN 1.0
                 WHEN lower(s.qualified_name) = ANY(${lowered}) THEN 0.95
                 ELSE 0.6
               END AS exactness
        FROM chunks c
        JOIN symbols s ON s.id = c.symbol_id
        WHERE ${acl}
          AND (
            lower(s.name) = ANY(${lowered})
            OR lower(s.qualified_name) = ANY(${lowered})
            OR s.qualified_name ILIKE ANY(${identifiers.map((i) => `%${i}%`)})
          )
        ORDER BY exactness DESC, length(s.qualified_name) ASC
        LIMIT ${limit}
      `);

      return rows.map((row, index) => ({
        chunkId: row.chunk_id,
        rank: index + 1,
        score: Number(row.exactness),
      }));
    });
  }

  /** Hydrate fused candidate ids into full chunks, re-applying the ACL predicate. */
  async hydrate(candidates: CandidateRef[], options: SearchOptions): Promise<ScoredChunk[]> {
    if (candidates.length === 0) return [];
    const acl = buildAclPredicate(options.access, options.scope);
    const ids = candidates.map((c) => c.chunkId);
    const byId = new Map(candidates.map((c) => [c.chunkId, c]));

    return withOrgContext(this.handle, options.access.orgId, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        symbol_id: string | null;
        module_id: string;
        repo_id: string;
        content: string;
        source_path: string | null;
        source_start_line: number | null;
        source_end_line: number | null;
        sensitivity: ScoredChunk['sensitivity'];
        analysis_depth: string;
        generated: boolean;
        corpus: string;
        token_count: number;
        cluster_modules: string[] | null;
      }>(sql`
        SELECT c.id, c.symbol_id, c.module_id, c.repo_id, c.content,
               c.source_path, c.source_start_line, c.source_end_line,
               c.sensitivity, c.analysis_depth, c.generated, c.corpus, c.token_count,
               CASE
                 WHEN c.duplicate_cluster_id IS NULL THEN NULL
                 ELSE (
                   SELECT array_agg(DISTINCT d.module_id)
                   FROM chunks d
                   WHERE d.duplicate_cluster_id = c.duplicate_cluster_id
                     AND d.org_id = c.org_id
                 )
               END AS cluster_modules
        FROM chunks c
        -- Re-applied rather than trusted from the arm queries. Hydration is a second read, and
        -- a second read gets a second filter (§10 Layer 4).
        WHERE ${acl} AND c.id = ANY(${ids})
      `);

      return rows
        .map((row) => {
          const candidate = byId.get(row.id);
          const chunk: ScoredChunk = {
            chunkId: row.id,
            symbolId: row.symbol_id,
            moduleId: row.module_id,
            repoId: row.repo_id,
            content: row.content,
            sourcePath: row.source_path,
            sourceStartLine: row.source_start_line,
            sourceEndLine: row.source_end_line,
            sensitivity: row.sensitivity,
            analysisDepth: row.analysis_depth,
            generated: row.generated,
            corpus: row.corpus,
            tokenCount: row.token_count,
            score: candidate?.score ?? 0,
            ranks: { fused: candidate?.rank },
          };
          const others = (row.cluster_modules ?? []).filter((m) => m !== row.module_id);
          if (others.length > 0) chunk.alsoPresentInModules = others;
          return chunk;
        })
        .sort((a, b) => (a.ranks.fused ?? 0) - (b.ranks.fused ?? 0));
    });
  }

  /**
   * Graph neighbours for expansion.
   *
   * Includes cross-repo edges, which is what makes "how does the web app authenticate against
   * the billing API" answerable at all (§4.3). Centrality comes back with each neighbour so
   * the expansion budget can drop the 400-caller utilities.
   */
  async neighbours(
    symbolIds: string[],
    options: SearchOptions,
    perSymbolLimit = 12,
  ): Promise<Map<string, GraphNeighbour[]>> {
    if (symbolIds.length === 0) return new Map();

    return withOrgContext(this.handle, options.access.orgId, async (tx) => {
      const rows = await tx.execute<{
        seed_symbol_id: string;
        symbol_id: string;
        qualified_name: string;
        signature: string;
        doc_summary: string | null;
        module_id: string;
        repo_id: string;
        source_path: string;
        source_start_line: number;
        relation: GraphNeighbour['relation'];
        centrality: number;
        sensitivity: ScoredChunk['sensitivity'];
        analysis_depth: string;
      }>(sql`
        WITH seeds AS (SELECT unnest(${symbolIds}::text[]) AS id),
        edges AS (
          -- Callees and referenced types, from the seed's own edge lists.
          SELECT s.id AS seed_symbol_id,
                 jsonb_array_elements_text(s.edges -> 'calls') AS target,
                 'callee'::text AS relation
          FROM symbols s JOIN seeds ON seeds.id = s.id
          UNION ALL
          SELECT s.id, jsonb_array_elements_text(s.edges -> 'references'), 'type'
          FROM symbols s JOIN seeds ON seeds.id = s.id
          UNION ALL
          SELECT s.id, jsonb_array_elements_text(s.edges -> 'usedBy'), 'caller'
          FROM symbols s JOIN seeds ON seeds.id = s.id
          UNION ALL
          -- Cross-repo edges: the frontend-call-to-backend-handler link (§4.3).
          SELECT e.from_symbol_id, e.to_symbol_id, 'callee'
          FROM cross_repo_edges e JOIN seeds ON seeds.id = e.from_symbol_id
          WHERE e.to_symbol_id IS NOT NULL AND e.status = 'resolved'
        ),
        ranked AS (
          SELECT edges.seed_symbol_id,
                 n.id AS symbol_id,
                 n.qualified_name,
                 n.signature,
                 n.doc_comment ->> 'summary' AS doc_summary,
                 n.module_id,
                 n.repo_id,
                 n.source_path,
                 n.source_start_line,
                 edges.relation,
                 jsonb_array_length(COALESCE(n.edges -> 'usedBy', '[]'::jsonb)) AS centrality,
                 n.sensitivity,
                 n.analysis_depth,
                 ROW_NUMBER() OVER (
                   PARTITION BY edges.seed_symbol_id
                   ORDER BY jsonb_array_length(COALESCE(n.edges -> 'usedBy', '[]'::jsonb)) ASC
                 ) AS rn
          FROM edges
          JOIN symbols n ON n.id = edges.target
          WHERE n.org_id = ${options.access.orgId}
            AND n.repo_id = ANY(${options.access.permittedRepoIds})
            AND n.sensitivity <> 'restricted'
        )
        SELECT * FROM ranked WHERE rn <= ${perSymbolLimit}
      `);

      const bySeed = new Map<string, GraphNeighbour[]>();
      for (const row of rows) {
        const list = bySeed.get(row.seed_symbol_id) ?? [];
        list.push({
          symbolId: row.symbol_id,
          qualifiedName: row.qualified_name,
          signature: row.signature,
          docSummary: row.doc_summary,
          moduleId: row.module_id,
          repoId: row.repo_id,
          sourcePath: row.source_path,
          sourceStartLine: row.source_start_line,
          relation: row.relation,
          centrality: Number(row.centrality),
          sensitivity: row.sensitivity,
          analysisDepth: row.analysis_depth,
        });
        bySeed.set(row.seed_symbol_id, list);
      }
      return bySeed;
    });
  }

  /** Repos whose index is behind HEAD — drives the hedging rule (§15.5). */
  async staleRepoIds(orgId: string, repoIds: string[]): Promise<string[]> {
    if (repoIds.length === 0) return [];
    return withOrgContext(this.handle, orgId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        SELECT id FROM repos
        WHERE org_id = ${orgId} AND id = ANY(${repoIds}) AND stale_since_sha IS NOT NULL
      `);
      return rows.map((r) => r.id);
    });
  }
}
