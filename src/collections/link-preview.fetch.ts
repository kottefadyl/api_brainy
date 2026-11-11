import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * T48: safe fetch for link previews. Only public http(s) addresses are reached (checked on the
 * resolved IP, so DNS rebinding and redirects to a private network are refused), with a short
 * timeout and a size cap. Nothing here follows more than 3 redirects.
 */
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (/^::ffff:/i.test(address)) return false;
  const family = isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function normalizedPreviewUrl(value: string): URL | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (url.port && !['80', '443'].includes(url.port)) return null;
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) return null;
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(url.hostname)) return null;
  url.hash = '';
  return url;
}

function safeLookup(hostname: string, options: object, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((item) => !isPublicAddress(item.address))) return callback(Object.assign(new Error('Private address refused'), { code: 'EPRIVATE' }), '');
    const wantsAll = (options as { all?: boolean }).all;
    return wantsAll ? callback(null, list) : callback(null, list[0].address, list[0].family);
  });
}

export type FetchedResource = { url: string; contentType: string; body: Buffer };

function once(url: URL, accept: string, maxBytes: number, timeoutMs: number): Promise<{ response: IncomingMessage; body?: Buffer; location?: string }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      lookup: safeLookup as never,
      timeout: timeoutMs,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; BrainyLinkPreview/1.0)', accept, 'accept-language': 'fr,en;q=0.8', 'accept-encoding': 'gzip, deflate, br' },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) { response.resume(); return resolve({ response, location: response.headers.location }); }
      if (status < 200 || status >= 300) { response.resume(); return reject(new Error(`HTTP ${status}`)); }
      const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
      const stream = encoding === 'gzip' ? response.pipe(createGunzip()) : encoding === 'deflate' ? response.pipe(createInflate()) : encoding === 'br' ? response.pipe(createBrotliDecompress()) : response;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes)))); request.destroy(); stream.destroy(); resolve({ response, body: Buffer.concat(chunks) }); return; }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve({ response, body: Buffer.concat(chunks) }));
      stream.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Timed out')));
    request.on('error', reject);
    request.end();
  });
}

export async function safeFetch(start: URL, accept: string, maxBytes: number, timeoutMs = 5000): Promise<FetchedResource> {
  let url = start;
  for (let hop = 0; hop <= 3; hop++) {
    const result = await once(url, accept, maxBytes, timeoutMs);
    if (result.location) {
      const next = normalizedPreviewUrl(new URL(result.location, url).toString());
      if (!next) throw new Error('Redirect refused');
      url = next;
      continue;
    }
    return { url: url.toString(), contentType: String(result.response.headers['content-type'] ?? ''), body: result.body ?? Buffer.alloc(0) };
  }
  throw new Error('Too many redirects');
}
