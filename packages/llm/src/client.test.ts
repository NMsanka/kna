import { describe, expect, it } from 'vitest';

import { LlmClient } from './client.js';

function embeddingResponse(): Response {
  return Response.json({
    data: [{ embedding: [0.25, 0.75], index: 0 }],
    model: 'embedding-route',
    usage: { prompt_tokens: 2 },
  });
}

describe('LlmClient authentication', () => {
  it('uses OpenAI-compatible Bearer authentication by default', async () => {
    let request: Request | null = null;
    const client = new LlmClient({
      baseUrl: 'https://models.example.test/',
      keys: { interactive: 'interactive-key', batch: 'batch-key' },
      region: 'local',
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return embeddingResponse();
      },
    });

    await client.embed({
      orgId: 'org_test',
      texts: ['hello'],
      dimensions: 2,
      contentSensitivity: 'internal',
    });

    expect(request).not.toBeNull();
    expect(request!.url).toBe('https://models.example.test/v1/embeddings');
    expect(request!.headers.get('authorization')).toBe('Bearer batch-key');
  });

  it('supports a raw credential in a custom header', async () => {
    let request: Request | null = null;
    const client = new LlmClient({
      baseUrl: 'https://models.example.test',
      keys: { interactive: 'interactive-key', batch: 'gateway-key' },
      authHeader: 'x-model-gateway-key',
      authScheme: 'raw',
      region: 'local',
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return embeddingResponse();
      },
    });

    await client.embed({
      orgId: 'org_test',
      texts: ['hello'],
      dimensions: 2,
      contentSensitivity: 'internal',
    });

    expect(request).not.toBeNull();
    expect(request!.headers.get('x-model-gateway-key')).toBe('gateway-key');
    expect(request!.headers.has('authorization')).toBe(false);
  });
});
