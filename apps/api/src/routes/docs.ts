import { sql } from 'drizzle-orm';
import { anyOf, withOrgContext } from '@kna/db';
import type { ApiContext, KnaServer } from '../context.js';

/**
 * Reading generated documentation.
 *
 * The platform regenerates documentation on every publish and, until now, there was no way to
 * read one. Documents were reachable only through `/v1/search`, which returns the fragments that
 * matched a query — useful for answering a question, useless for reading a page. A document that
 * contains a Mermaid diagram came back as a few lines from the middle of it.
 *
 * That gap decides an architectural question rather than being a missing convenience. ADR 0001
 * says the documentation *site* is bought rather than built — Docusaurus or Nextra rendering the
 * Markdown — and every such tool reads Markdown files from a folder. Without an endpoint, the
 * only way to get those files is to write them into each repository and build from there. With
 * one, a site generator or a scheduled export can pull them from the platform instead, and a
 * repository that does not want a CI workflow does not need one.
 *
 * Both routes filter by the caller's permitted repositories and clearance, exactly as retrieval
 * does. Documentation is derived from code and inherits its sensitivity; a document nobody may
 * read the source of is not a document they may read.
 */

interface DocRow extends Record<string, unknown> {
  slug: string;
  title: string;
  doc_type: string;
  repo_id: string | null;
  module_id: string | null;
  sensitivity: string;
  status: string;
  staleness_score: number;
  updated_at: Date;
}

export async function registerDocsRoutes(app: KnaServer, ctx: ApiContext): Promise<void> {
  /**
   * The catalogue. What a site generator crawls, or a developer browses.
   */
  app.get<{ Querystring: { repoId?: string; docType?: string } }>(
    '/v1/docs',
    async (request, reply) => {
      const principal = await ctx.authenticate(request);
      const access = await ctx.permissions.resolve(principal, { corpus: 'internal' });

      // Same uniform response as retrieval. §15.7 — a different answer for "no permission" than
      // for "nothing here" turns the endpoint into an oracle for what exists.
      if (access.permittedRepoIds.length === 0) {
        return reply.send({ documents: [] });
      }

      const { repoId, docType } = request.query;

      const rows = await withOrgContext(ctx.db, principal.orgId, async (tx) =>
        tx.execute<DocRow>(sql`
          -- One row per (repo, slug). A document is stored per version, so a repository indexed
          -- on two refs has two rows for the same page; listing both is noise, and the newest is
          -- what "the documentation" means to a reader.
          SELECT DISTINCT ON (repo_id, slug)
                 slug, title, doc_type, repo_id, module_id, sensitivity, status,
                 staleness_score, updated_at
            FROM documents
           WHERE org_id = ${principal.orgId}
             AND repo_id = ${anyOf(access.permittedRepoIds)}
             AND sensitivity = ${anyOf(readableTiers(access.clearance))}
             ${repoId ? sql`AND repo_id = ${repoId}` : sql``}
             ${docType ? sql`AND doc_type = ${docType}` : sql``}
           ORDER BY repo_id, slug, updated_at DESC
        `),
      );

      // Sorted for a reader rather than for the DISTINCT ON, which had to order by repo first.
      rows.sort((a, b) => `${a.doc_type}${a.slug}`.localeCompare(`${b.doc_type}${b.slug}`));

      return reply.send({
        documents: rows.map((row) => ({
          slug: String(row.slug),
          title: String(row.title),
          docType: String(row.doc_type),
          repoId: row.repo_id === null ? null : String(row.repo_id),
          moduleId: row.module_id === null ? null : String(row.module_id),
          status: String(row.status),
          stalenessScore: Number(row.staleness_score),
          updatedAt: new Date(String(row.updated_at)).toISOString(),
        })),
      });
    },
  );

  /**
   * One document.
   *
   * `?format=markdown` returns the raw file with a Markdown content type, so a static site
   * generator or a scheduled export can write it straight to disk without unwrapping JSON. The
   * default is JSON, because a browser or a viewer usually wants the provenance alongside the
   * text — which commit it describes, and how stale it has become.
   *
   * Slugs contain slashes (`reference/packages-db`), so the parameter is a wildcard.
   */
  app.get<{ Params: { '*': string }; Querystring: { format?: string; repoId?: string } }>(
    '/v1/docs/*',
    async (request, reply) => {
      const principal = await ctx.authenticate(request);
      const access = await ctx.permissions.resolve(principal, { corpus: 'internal' });
      const slug = request.params['*'];
      const wantedRepo = request.query.repoId;

      const rows =
        access.permittedRepoIds.length === 0
          ? []
          : await withOrgContext(ctx.db, principal.orgId, async (tx) =>
              tx.execute<{
                slug: string;
                title: string;
                doc_type: string;
                content: string;
                repo_id: string | null;
                module_id: string | null;
                version_id: string;
                repo_path: string | null;
                provenance_symbol_ids: string[];
                status: string;
                staleness_score: number;
                generated_at: Date | null;
                updated_at: Date;
              }>(sql`
                SELECT slug, title, doc_type, content, repo_id, module_id, version_id,
                       repo_path, provenance_symbol_ids, status, staleness_score,
                       generated_at, updated_at
                  FROM documents
                 WHERE org_id = ${principal.orgId}
                   AND slug = ${slug}
                   AND repo_id = ${anyOf(access.permittedRepoIds)}
                   AND sensitivity = ${anyOf(readableTiers(access.clearance))}
                   ${wantedRepo ? sql`AND repo_id = ${wantedRepo}` : sql``}
                 -- Newest version first: within one repository, later beats earlier. Across
                 -- repositories there is no such ordering, which is what the check below is for.
                 ORDER BY updated_at DESC
              `),
            );

      // Slugs are unique per repository, not across them: every indexed repository has an
      // `architecture/overview`. Returning whichever sorted first would hand back another
      // project's documentation and look like a correct answer, so the ambiguity is reported
      // rather than resolved by guessing.
      const repos = [...new Set(rows.map((r) => String(r.repo_id)))];
      if (repos.length > 1) {
        return reply.code(409).send({
          error: {
            code: 'ambiguous_slug',
            message: `'${slug}' exists in ${repos.length} repositories you can read.`,
            guidance: `Add ?repoId= to choose one: ${repos.join(', ')}`,
          },
        });
      }

      const row = rows[0];
      if (!row) {
        // Deliberately the same 404 whether the document does not exist or the caller may not
        // read it. Distinguishing them would leak the existence of documentation for private
        // repositories to anyone who can guess a slug.
        return reply.code(404).send({
          error: {
            code: 'document_not_found',
            message: `No document '${slug}' is available to you.`,
            guidance: 'GET /v1/docs lists what you can read.',
          },
        });
      }

      await ctx.audit.record({
        orgId: principal.orgId,
        action: 'docs.read',
        actorType: 'user',
        actorId: principal.id,
        resourceType: 'document',
        resourceId: String(row.slug),
        outcome: 'success',
        reposTouched: row.repo_id ? [String(row.repo_id)] : [],
      });

      if (request.query.format === 'markdown') {
        return reply.type('text/markdown; charset=utf-8').send(String(row.content));
      }

      return reply.send({
        slug: String(row.slug),
        title: String(row.title),
        docType: String(row.doc_type),
        content: String(row.content),
        repoId: row.repo_id === null ? null : String(row.repo_id),
        moduleId: row.module_id === null ? null : String(row.module_id),
        versionId: String(row.version_id),
        repoPath: row.repo_path === null ? null : String(row.repo_path),
        provenanceSymbolCount: (row.provenance_symbol_ids ?? []).length,
        status: String(row.status),
        stalenessScore: Number(row.staleness_score),
        generatedAt: row.generated_at ? new Date(String(row.generated_at)).toISOString() : null,
        updatedAt: new Date(String(row.updated_at)).toISOString(),
      });
    },
  );
}

/**
 * Clearance is a ceiling: a caller sees their tier and everything below it.
 *
 * `restricted` is absent on purpose. §10 Layer 3 keeps restricted content out of the retrieval
 * pipeline entirely, and a document generated from restricted code inherits that exclusion — it
 * is reachable by direct, audited symbol lookup or not at all.
 */
function readableTiers(clearance: string): string[] {
  const order = ['public', 'internal', 'confidential'];
  const ceiling = order.indexOf(clearance);
  return ceiling === -1 ? ['public'] : order.slice(0, ceiling + 1);
}
