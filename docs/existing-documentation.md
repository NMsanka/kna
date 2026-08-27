# Existing documentation ingestion

KNA ingests existing documentation through a source-neutral connector contract. Phase 1 includes
repository Markdown and MDX files. A later Confluence, Freshdesk, Jira, or Azure DevOps connector
uses the same contract and does not change the indexing or retrieval pipeline.

## Data flow

1. A connector reads pages from one source.
2. The connector converts each page to a `KnowledgeDocument` in the IR bundle.
3. The document indexer splits the normalized content by Markdown section and creates embeddings.
4. Retrieval searches code and documentation as separate ranked corpora, then combines the results.
5. Search and answer citations retain the repository path or external source URL.

Connectors own acquisition, source cursors, revision identifiers, and conversion to the normalized
document shape. They do not write database rows or create embeddings. This boundary keeps source
credentials and API behavior out of the shared indexing pipeline.

## Repository Markdown source

The default source reads `README.md`, `**/*.md`, and `**/*.mdx`. It excludes `.git`,
`node_modules`, and `docs/generated`. Configure it in `.kna.yaml`:

```yaml
documents:
  sources:
    - type: repo-markdown
      enabled: true
      include:
        - README.md
        - "**/*.md"
        - "**/*.mdx"
      exclude:
        - "**/node_modules/**"
        - "**/.git/**"
        - "docs/generated/**"
```

Optional front matter can set `title`, `documentType`, `audience`, `authority`, and `sensitivity`.
If these values are absent, the connector uses conservative defaults and simple path-based
classification.

## Adding an external source

Implement `DocumentSourceConnector` from `@kna/documents`. The connector must provide stable source
and document identifiers, a revision value, normalized content, access metadata, and tombstones for
deleted pages. The common indexer then handles chunking, embeddings, persistence, associations, and
retrieval.

External access rules fail closed. A document with source-specific permissions is not returned until
an adapter maps those permissions to KNA principals or groups. Public documents and documents that
inherit repository access can be returned immediately.

## Storage and linking

Documentation has its own source, document, association, chunk, and embedding metadata. Its vectors
are marked as the `docs` corpus and are indexed separately from code vectors. Both corpora still use
the same repository, project, module, version, and sensitivity scope where applicable. This permits
one answer to use evidence from source code and existing documentation without merging the two
lifecycles or losing provenance.
