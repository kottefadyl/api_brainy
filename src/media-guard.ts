// Pictures, videos, sound and PDF files are not stored in the database on Vercel's free plan (module
// "mediaFiles"). A file is recognized by its type, its name and its first bytes, so renaming a photo
// does not get it through.
const MEDIA_EXTENSIONS = /\.(jpe?g|jfif|png|gif|webp|avif|heic|heif|bmp|tiff?|ico|svg|psd|raw|cr2|nef|mp4|m4v|mov|avi|mkv|webm|wmv|flv|3gp|mpe?g|ogv|mp3|m4a|wav|ogg|oga|flac|aac|opus|wma|amr|pdf)$/i;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
}
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** True for a picture, a video, a sound or a PDF file. */
export function isMediaFile(name: string, mimeType?: string | null, bytes?: Uint8Array | null): boolean {
  const type = (mimeType ?? '').toLowerCase();
  if (/^(image|video|audio)\//.test(type) || type === 'application/pdf') return true;
  if (MEDIA_EXTENSIONS.test(name.trim())) return true;
  if (!bytes?.length) return false;
  return startsWith(bytes, ascii('%PDF'))
    || startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) // PNG
    || startsWith(bytes, [0xff, 0xd8, 0xff]) // JPEG
    || startsWith(bytes, ascii('GIF8'))
    || startsWith(bytes, ascii('BM'))
    || startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]) // TIFF
    || (startsWith(bytes, ascii('RIFF')) && (startsWith(bytes, ascii('WEBP'), 8) || startsWith(bytes, ascii('AVI '), 8) || startsWith(bytes, ascii('WAVE'), 8)))
    || startsWith(bytes, ascii('ftyp'), 4) // MP4, MOV, HEIC, AVIF, M4A
    || startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) // WebM, MKV
    || startsWith(bytes, ascii('OggS'))
    || startsWith(bytes, ascii('ID3')) || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3]) || startsWith(bytes, [0xff, 0xf2]) // MP3
    || startsWith(bytes, ascii('fLaC'))
    || startsWith(bytes, [0x00, 0x00, 0x01, 0xba]) || startsWith(bytes, [0x00, 0x00, 0x01, 0xb3]); // MPEG
}

export const MEDIA_REFUSED = 'Pictures, videos, sound and PDF files are not stored on this hosting plan';
