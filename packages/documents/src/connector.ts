import type { KnowledgeDocument } from '@kna/ir';

export interface DocumentSourceCursor {
  value: string;
}
export interface DocumentSourceRequest {
  cursor?: DocumentSourceCursor | null;
  limit?: number;
}
export interface DocumentTombstone {
  externalId: string;
  revision: string;
}
export interface DocumentSourcePage {
  documents: KnowledgeDocument[];
  tombstones: DocumentTombstone[];
  nextCursor: DocumentSourceCursor | null;
  hasMore: boolean;
}

/** Connectors acquire and normalize. Scanning, chunking, persistence, and retrieval are shared. */
export interface DocumentSourceConnector {
  readonly sourceType: string;
  readonly instanceId: string;
  pull(request?: DocumentSourceRequest): Promise<DocumentSourcePage>;
}
