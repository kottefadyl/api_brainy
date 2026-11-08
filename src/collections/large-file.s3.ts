// T44 — minimal S3 client (AWS Signature V4, path-style) over fetch: no SDK dependency.
// Works with MinIO and other S3-compatible stores. Only the calls Brainy needs.
import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding as required by SigV4.
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (path: string) => path.split('/').map(encode).join('/');

export class S3Error extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

@Injectable()
export class S3Storage {
  readonly bucket = process.env.S3_BUCKET ?? 'brainy-large-files';
  private readonly endpoint = new URL(process.env.S3_ENDPOINT ?? 'http://localhost:9000');
  private readonly publicEndpoint = new URL(process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? 'http://localhost:9000');
  private readonly region = process.env.S3_REGION ?? 'us-east-1';
  private readonly accessKey = process.env.S3_ACCESS_KEY ?? '';
  private readonly secretKey = process.env.S3_SECRET_KEY ?? '';
  private bucketReady?: Promise<void>;

  get configured(): boolean { return !!this.accessKey && !!this.secretKey; }

  private signingKey(date: string): Buffer {
    return hmac(hmac(hmac(hmac(`AWS4${this.secretKey}`, date), this.region), 's3'), 'aws4_request');
  }

  private canonicalQuery(query: Record<string, string>): string {
    return Object.keys(query).sort().map((key) => `${encode(key)}=${encode(query[key])}`).join('&');
  }

  private async request(method: string, key: string | null, options: { query?: Record<string, string>; body?: Buffer | string; payloadHash?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const query = options.query ?? {};
    const path = `/${encodePath(this.bucket)}${key === null ? '' : `/${encodePath(key)}`}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = options.payloadHash ?? sha256Hex(options.body ?? '');
    const headers: Record<string, string> = { host: this.endpoint.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(options.headers ?? {}) };
    const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()]));
    const canonical = [method, path, this.canonicalQuery(query), names.map((name) => `${name}:${lower[name]}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
    const signature = createHmac('sha256', this.signingKey(date)).update(toSign).digest('hex');
    const url = `${this.endpoint.protocol}//${this.endpoint.host}${path}${Object.keys(query).length ? `?${this.canonicalQuery(query)}` : ''}`;
    const { host: _host, ...sent } = headers;
    void _host;
    const response = await fetch(url, {
      method,
      headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
      body: typeof options.body === "string" || options.body === undefined ? options.body : new Uint8Array(options.body),
    });
    if (!response.ok && !(method === 'HEAD' && response.status === 404)) {
      const text = method === 'HEAD' ? '' : await response.text();
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${response.status}`;
      throw new S3Error(response.status, code, `Storage error ${code}`);
    }
    return response;
  }

  /** Creates the bucket on first use (local MinIO); a managed bucket simply already exists. */
  ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try { await this.request('PUT', null); }
      catch (error) { if (!(error instanceof S3Error) || !['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.code)) { this.bucketReady = undefined; throw error; } }
    })();
    return this.bucketReady;
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    await this.ensureBucket();
    const response = await this.request('POST', key, { query: { uploads: '' }, headers: { 'content-type': contentType } });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await response.text())?.[1];
    if (!uploadId) throw new S3Error(500, 'NoUploadId', 'Storage did not start the upload');
    return uploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, data: Buffer, sha256: string): Promise<string> {
    const response = await this.request('PUT', key, { query: { partNumber: String(partNumber), uploadId }, body: data, payloadHash: sha256 });
    return response.headers.get('etag') ?? '';
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const body = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const response = await this.request('POST', key, { query: { uploadId }, body, headers: { 'content-type': 'application/xml' } });
    const text = await response.text();
    if (/<Error>/.test(text)) throw new S3Error(500, /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? 'CompleteFailed', 'Storage could not assemble the file');
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try { await this.request('DELETE', key, { query: { uploadId } }); }
    catch (error) { if (!(error instanceof S3Error) || error.status !== 404) throw error; }
  }

  /** Size of a stored object, or null when it is missing. */
  async head(key: string): Promise<number | null> {
    const response = await this.request('HEAD', key);
    if (response.status === 404) return null;
    return Number(response.headers.get('content-length') ?? 0);
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer> {
    const response = await this.request('GET', key, { headers: { range: `bytes=${start}-${end}` } });
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    try { await this.request('DELETE', key); }
    catch (error) { if (!(error instanceof S3Error) || error.status !== 404) throw error; }
  }

  /** Short-lived GET link signed for the public endpoint (query-string SigV4). */
  presignGet(key: string, seconds: number, fileName: string, contentType: string): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const path = `/${encodePath(this.bucket)}/${encodePath(key)}`;
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKey}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(seconds),
      'X-Amz-SignedHeaders': 'host',
      'response-content-disposition': `attachment; filename*=UTF-8''${encode(fileName)}`,
      'response-content-type': contentType,
    };
    const canonical = ['GET', path, this.canonicalQuery(query), `host:${this.publicEndpoint.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
    const signature = createHmac('sha256', this.signingKey(date)).update(toSign).digest('hex');
    return `${this.publicEndpoint.protocol}//${this.publicEndpoint.host}${path}?${this.canonicalQuery(query)}&X-Amz-Signature=${signature}`;
  }
}
