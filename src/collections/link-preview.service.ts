import { isFrozen } from '../platform';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Field, ObjectType } from '@nestjs/graphql';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { normalizedPreviewUrl, safeFetch } from './link-preview.fetch';

/** T48: cached Open Graph preview of a saved link. The image is copied so clients never call the site. */
@Schema({ timestamps: true, collection: 'link_previews' })
export class LinkPreviewCache {
  @Prop({ required: true, unique: true }) url!: string;
  @Prop() title?: string;
  @Prop() description?: string;
  @Prop() siteName?: string;
  @Prop() image?: string;
  @Prop({ default: false }) video!: boolean;
  @Prop({ default: false }) available!: boolean;
  @Prop({ required: true }) fetchedAt!: Date;
}
export const LinkPreviewCacheSchema = SchemaFactory.createForClass(LinkPreviewCache);

@ObjectType()
export class LinkPreview {
  @Field() url!: string;
  @Field() available!: boolean;
  @Field({ nullable: true }) title?: string;
  @Field({ nullable: true }) description?: string;
  @Field({ nullable: true }) siteName?: string;
  /** data: URL of a small image (at most 600 KB), or empty. */
  @Field({ nullable: true }) image?: string;
  @Field() video!: boolean;
}

const fresh = 7 * 24 * 3600_000, retryFailed = 6 * 3600_000;
const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') { const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10); return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match; }
    return named[code.toLowerCase()] ?? match;
  });
}

const clean = (value: string | undefined, max: number) => {
  const text = value ? decodeEntities(value).replace(/\s+/g, ' ').trim() : '';
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined;
};

/** Reads Open Graph, Twitter and basic HTML metadata from the start of a page. */
export function parseMetadata(html: string): { title?: string; description?: string; siteName?: string; image?: string; video: boolean } {
  const head = html.slice(0, 400_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attribute = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    const key = attribute('property') ?? attribute('name');
    const content = attribute('content');
    const name = key && (key[1] ?? key[2] ?? key[3])?.toLowerCase();
    const value = content && (content[1] ?? content[2] ?? content[3]);
    if (name && value && !meta.has(name)) meta.set(name, value);
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const type = meta.get('og:type') ?? '';
  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 200),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 300),
    siteName: clean(meta.get('og:site_name') ?? meta.get('application-name'), 80),
    image: meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src'),
    video: type.startsWith('video') || meta.has('og:video') || meta.has('og:video:url'),
  };
}

export function youtubeId(url: URL): string | null {
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
  if (host !== 'youtube.com') return null;
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const match = url.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
  return match?.[2] ?? null;
}

@Injectable()
export class LinkPreviewService {
  private readonly recent = new Map<string, number[]>();
  constructor(@InjectModel(LinkPreviewCache.name) private readonly cache: Model<LinkPreviewCache>) {}

  private allow(userId: string): boolean {
    const now = Date.now();
    const times = (this.recent.get(userId) ?? []).filter((time) => now - time < 60_000);
    if (times.length >= 30) return false;
    times.push(now);
    this.recent.set(userId, times);
    return true;
  }

  private async image(source: string | undefined, base: string): Promise<string | undefined> {
    // On Vercel's free plan no picture is kept in the database: the preview keeps its text only.
    if (!source || isFrozen('mediaFiles')) return undefined;
    const url = normalizedPreviewUrl(new URL(decodeEntities(source), base).toString());
    if (!url) return undefined;
    try {
      const file = await safeFetch(url, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', 600_000, 5000);
      const type = file.contentType.split(';')[0].trim().toLowerCase();
      if (!imageTypes.includes(type) || file.body.length < 64 || file.body.length >= 600_000) return undefined;
      return `data:${type};base64,${file.body.toString('base64')}`;
    } catch { return undefined; }
  }

  private async fetchPreview(url: URL): Promise<Omit<LinkPreviewCache, 'fetchedAt' | 'url'>> {
    const video = youtubeId(url);
    if (video) {
      const oembed = new URL('https://www.youtube.com/oembed');
      oembed.searchParams.set('url', `https://www.youtube.com/watch?v=${video}`);
      oembed.searchParams.set('format', 'json');
      const data = JSON.parse((await safeFetch(oembed, 'application/json', 100_000)).body.toString('utf8')) as { title?: string; author_name?: string };
      const image = await this.image(`https://i.ytimg.com/vi/${video}/hqdefault.jpg`, 'https://i.ytimg.com/');
      return { title: clean(data.title, 200), description: clean(data.author_name, 300), siteName: 'YouTube', image, video: true, available: true };
    }
    const page = await safeFetch(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 512_000);
    const type = page.contentType.toLowerCase();
    if (type.startsWith('image/')) {
      const image = await this.image(page.url, page.url);
      return { title: decodeURIComponent(new URL(page.url).pathname.split('/').pop() ?? '') || undefined, siteName: new URL(page.url).hostname.replace(/^www\./, ''), image, video: false, available: true };
    }
    if (!type.includes('html')) return { siteName: new URL(page.url).hostname.replace(/^www\./, ''), video: false, available: false };
    const charset = type.match(/charset=([\w-]+)/)?.[1] ?? page.body.subarray(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
    let html: string;
    try { html = new TextDecoder(charset).decode(page.body); } catch { html = page.body.toString('utf8'); }
    const metadata = parseMetadata(html);
    return { title: metadata.title, description: metadata.description, siteName: metadata.siteName ?? new URL(page.url).hostname.replace(/^www\./, ''), image: await this.image(metadata.image, page.url), video: metadata.video, available: !!(metadata.title || metadata.description) };
  }

  async preview(value: string, userId: string): Promise<LinkPreview> {
    const url = normalizedPreviewUrl(value);
    if (!url || value.length > 2000) throw new BadRequestException('Enter a public web address');
    const key = url.toString();
    const cached = await this.cache.findOne({ url: key }).lean().exec();
    const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
    if (cached && age < (cached.available ? fresh : retryFailed)) return this.view(cached);
    if (!this.allow(userId)) {
      if (cached) return this.view(cached);
      return { url: key, available: false, video: false, siteName: url.hostname.replace(/^www\./, '') };
    }
    let result: Omit<LinkPreviewCache, 'fetchedAt' | 'url'>;
    try { result = await this.fetchPreview(url); }
    catch { result = { siteName: url.hostname.replace(/^www\./, ''), video: false, available: false }; }
    const saved = await this.cache.findOneAndUpdate({ url: key }, { $set: { ...result, url: key, fetchedAt: new Date() }, $unset: { ...(result.image ? {} : { image: '' }) } }, { upsert: true, returnDocument: 'after' }).lean().exec();
    return this.view(saved!);
  }

  private view(item: LinkPreviewCache): LinkPreview {
    return { url: item.url, available: item.available, title: item.title, description: item.description, siteName: item.siteName, image: item.image, video: item.video };
  }
}
