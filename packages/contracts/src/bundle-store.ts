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

    // Note what is *not* sent here: a per-object `x-amz-object-lock-mode`.
    //
    // §15.1 requires these bundles to be immutable, but object lock is a property of the
    // bucket, configured at creation and enforced by a default retention rule. Asserting it
    // per object fails with `InvalidRequest: Bucket is missing ObjectLockConfiguration` on any
    // bucket not created with `--with-lock`, and a mode without a retain-until date is invalid
    // even on one that was. The result was that ingest failed at the first write rather than
    // at deploy time.
    //
    // Immutability is therefore infrastructure configuration, verified by `objectLockEnabled()`
    // and asserted at startup in production, rather than a header on the hot path.
    await this.request('PUT', key, body, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'x-amz-meta-ir-schema-version': bundle.envelope.irSchemaVersion,
      'x-amz-meta-payload-hash': bundle.envelope.payloadHash,
    });

    return key;
  }

  async get(key: string): Promise<IrBundle> {
    const response = await this.request('GET', key);
    const buffer = Buffer.from(await response.arrayBuffer());
    // Sniff the bytes rather than trusting the key suffix. The object is stored with
    // `content-encoding: gzip`, so `fetch` transparently decompresses it — and gunzipping
    // already-decompressed bytes fails with "incorrect header check", an error that says
    // nothing about where the double-decompression happened. Any proxy or CDN in front of the
    // store can do the same, so the magic bytes are the only reliable signal.
    const json = isGzip(buffer) ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
    return JSON.parse(json) as IrBundle;
  }

  async getPayload(key: string): Promise<IrBundlePayload> {
    return (await this.get(key)).payload;
  }

  /**
   * Whether the bucket actually enforces immutability.
   *
   * §15.1 makes the bundle store the system of record and Postgres a derived cache, which only
   * holds if a stored bundle cannot be rewritten. A bucket without object lock looks identical
   * in every other respect, so this is checked explicitly rather than assumed — production
   * asserts it at startup, development logs it and continues.
   */
  async objectLockEnabled(): Promise<boolean> {
    try {
      const response = await this.request('GET', '', undefined, {}, true, '?object-lock=');
      const xml = await response.text();
      return /<ObjectLockEnabled>Enabled<\/ObjectLockEnabled>/.test(xml);
    } catch {
      return false;
    }
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

/** gzip magic number: 0x1f 0x8b. */
function isGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
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
