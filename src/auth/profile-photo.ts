import { BadRequestException } from '@nestjs/common';

/** Largest accepted profile photo, in decoded bytes (1 MiB). Clients compress larger pictures first. */
export const PROFILE_PHOTO_MAX_BYTES = 1024 * 1024;

const dataUrlPattern = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function matchesSignature(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

/** Validates a profile photo data URL and returns it normalised, or throws a user-facing error. */
export function validateProfilePhoto(photo: string): string {
  const match = dataUrlPattern.exec(photo.trim());
  if (!match) throw new BadRequestException('Profile photo must be a JPEG, PNG or WebP image');
  const [, mime, base64] = match;
  if (base64.length > Math.ceil(PROFILE_PHOTO_MAX_BYTES / 3) * 4 + 4) {
    throw new BadRequestException('Profile photo must be at most 1 MB');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > PROFILE_PHOTO_MAX_BYTES) throw new BadRequestException('Profile photo must be at most 1 MB');
  if (!matchesSignature(mime, bytes)) throw new BadRequestException('Profile photo must be a JPEG, PNG or WebP image');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
