-- Connector-neutral existing-documentation ingestion.
--
-- Documentation has a different acquisition, revision, ACL, and deletion lifecycle from code.
-- These records preserve that lifecycle while `chunks.corpus = 'docs'` keeps retrieval isolated.

CREATE TABLE document_sources (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  source_type     text NOT NULL,
  instance_id     text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor          text,
  status          text NOT NULL DEFAULT 'active',
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_sources_identity_idx ON document_sources (org_id, source_type, instance_id);
CREATE INDEX document_sources_status_idx ON document_sources (org_id, status);

ALTER TABLE documents
  ADD COLUMN source_id text,
  ADD COLUMN source_type text NOT NULL DEFAULT 'generated',
  ADD COLUMN source_instance_id text,
  ADD COLUMN external_id text,
  ADD COLUMN source_revision text,
  ADD COLUMN canonical_url text,
  ADD COLUMN audience text NOT NULL DEFAULT 'developer',
  ADD COLUMN authority text NOT NULL DEFAULT 'supporting',
  ADD COLUMN access_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN source_updated_at timestamptz,
  ADD COLUMN deleted_at timestamptz;

CREATE UNIQUE INDEX documents_source_identity_idx
  ON documents (org_id, source_type, source_instance_id, external_id, version_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE document_associations (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  document_id       text NOT NULL,
  repo_id           text,
  project_id        text,
  module_id         text,
  symbol_id         text,
  association_type  text NOT NULL,
  confidence        real NOT NULL DEFAULT 1,
  created_by        text NOT NULL DEFAULT 'connector',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_associations_identity_idx
  ON document_associations (
    org_id, document_id, repo_id, project_id, module_id, symbol_id, association_type
  ) NULLS NOT DISTINCT;
CREATE INDEX document_associations_repo_idx ON document_associations (org_id, repo_id, document_id);
CREATE INDEX document_associations_project_idx ON document_associations (org_id, project_id, document_id);

ALTER TABLE chunks ALTER COLUMN module_id DROP NOT NULL;
ALTER TABLE embeddings ALTER COLUMN module_id DROP NOT NULL;
ALTER TABLE embeddings ADD COLUMN corpus text NOT NULL DEFAULT 'code';
UPDATE embeddings e SET corpus = c.corpus FROM chunks c WHERE c.id = e.chunk_id;
ALTER TABLE chunks ADD COLUMN document_id text;
ALTER TABLE chunks ADD COLUMN source_url text;
CREATE INDEX chunks_document_idx ON chunks (org_id, document_id, version_id);
CREATE INDEX embeddings_corpus_scope_idx ON embeddings (org_id, model, corpus, version_id);

-- Separate ANN graphs prevent a large code corpus from crowding documentation candidates out
-- before the corpus filter is applied. Retrieval fuses the two ranked lists afterwards.
CREATE INDEX CONCURRENTLY embeddings_code_hnsw_idx
  ON embeddings USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE corpus <> 'docs';
CREATE INDEX CONCURRENTLY embeddings_docs_hnsw_idx
  ON embeddings USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE corpus = 'docs';

ALTER TABLE document_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY document_sources_org_isolation ON document_sources
  USING (org_id = kna_current_org()) WITH CHECK (org_id = kna_current_org());

ALTER TABLE document_associations ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_associations FORCE ROW LEVEL SECURITY;
CREATE POLICY document_associations_org_isolation ON document_associations
  USING (org_id = kna_current_org()) WITH CHECK (org_id = kna_current_org());

GRANT SELECT ON document_sources, document_associations TO kna_interactive;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_sources, document_associations TO kna_batch;
