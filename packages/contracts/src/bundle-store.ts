import { createHash, createHmac } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { IrBundle, IrBundlePayload } from '@kna/ir';

/**
 * The IR bundle store — the system of record.
 *
 * §15.1 fix 1: "Persist every published IR bundle immutably to object storage, keyed
 * `(orgId, repoId, commitSha)`, versioned and lifecycle-managed. Postgres becomes an explicitly
 * *derived cache*. This single decision gives you: a real disaster-recovery story..., a
 * realistic staging corpus via bundle replay, reproducible evaluation, and cheap reindexing
 * when the embedding model changes."
 *
 * Implemented against the S3 API directly rather than through the AWS SDK: the surface used is
 * four verbs, and the SDK is a large dependency for a service whose only job is PUT and GET.
 * Works unchanged against MinIO, which is what the local stack runs.
 */

export interface BundleStoreOptions {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  fetchImpl?: typeof fetch;
}

export class BundleStore {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BundleStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Key layout is deliberate. Org first so a tenant's objects can be lifecycle-managed,
   * replicated, or crypto-shredded as a unit (§15.7); commit last so listing a repo's history
   * is a prefix scan.
   */
  static key(orgId: string, repoId: string, commitSha: string, bundleId: string): string {
    return `${orgId}/${repoId}/${commitSha}/${bundleId}.json.gz`;
  }

  async put(bundle: IrBundle): Promise<string> {
    const key = BundleStore.key(
      bundle.envelope.orgId,
      bundle.envelope.repoId,
      bundle.envelope.commitSha,
      bundle.envelope.bundleId,
    );

    const body = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 6 });
    await this.request('PUT', key, body, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      // Immutability is asserted at write time. A bundle that can be rewritten is not a system
      // of record, and DR that depends on "nobody overwrote it" is not a DR story.
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-meta-ir-schema-version': bundle.envelope.irSchemaVersion,
      'x-amz-meta-payload-hash': bundle.envelope.payloadHash,
    });

    return key;
  }

  async get(key: string): Promise<IrBundle> {
    const response = await this.request('GET', key);
    const buffer = Buffer.from(await response.arrayBuffer());
    const json = key.endsWith('.gz')
      ? gunzipSync(buffer).toString('utf8')
      : buffer.toString('utf8');
    return JSON.parse(json) as IrBundle;
  }

  async getPayload(key: string): Promise<IrBundlePayload> {
    return (await this.get(key)).payload;
  }

  async healthy(): Promise<boolean> {
    try {
      const response = await this.request('HEAD', '', undefined, {}, true);
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  /**
   * §15.1 — "a realistic staging corpus via bundle replay". Listing by prefix is what makes
   * "rebuild this org's index from scratch" and "replay production into staging" the same
   * operation with a different destination.
   */
  async listKeys(prefix: string, limit = 1000): Promise<string[]> {
    const response = await this.request(
      'GET',
      '',
      undefined,
      {},
      true,
      `?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${limit}`,
    );
    const xml = await response.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
  }

  private async request(
    method: string,
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
    bucketLevel = false,
    query = '',
  ): Promise<Response> {
    const path = bucketLevel ? `/${this.options.bucket}${query}` : `/${this.options.bucket}/${key}`;
    const url = `${this.options.endpoint.replace(/\/$/, '')}${path}`;
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = timestamp.slice(0, 8);

    const payloadHash = body
      ? createHash('sha256').update(body).digest('hex')
      : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const headers: Record<string, string> = {
      ...extraHeaders,
      host: new URL(url).host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
    };

    headers['authorization'] = this.sign(
      method,
      path,
      query,
      headers,
      payloadHash,
      date,
      timestamp,
    );

    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
    });

    if (!response.ok && method !== 'HEAD') {
      const text = await response.text().catch(() => '');
      throw new BundleStoreError(
        `Bundle store ${method} ${path} failed with ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
    }

    return response;
  }

  /** AWS SigV4. Verbose, but the alternative is a very large dependency for four verbs. */
  private sign(
    method: string,
    path: string,
    query: string,
    headers: Record<string, string>,
    payloadHash: string,
    date: string,
    timestamp: string,
  ): string {
    const signedHeaderNames = Object.keys(headers)
      .filter((h) => h !== 'authorization')
      .map((h) => h.toLowerCase())
      .sort();

    const canonicalHeaders = signedHeaderNames
      .map(
        (name) =>
          `${name}:${String(headers[name] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === name)!]).trim()}\n`,
      )
      .join('');

    const canonicalRequest = [
      method,
      path,
      query.replace(/^\?/, ''),
      canonicalHeaders,
      signedHeaderNames.join(';'),
      payloadHash,
    ].join('\n');

    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      timestamp,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const kDate = createHmac('sha256', `AWS4${this.options.secretKey}`).update(date).digest();
    const kRegion = createHmac('sha256', kDate).update(this.options.region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  }
}

export class BundleStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BundleStoreError';
  }
}
