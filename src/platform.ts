import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Modules that need a process running between requests, or request bodies
 * above 4.5 MB. Vercel's free Hobby plan offers neither: no background loop,
 * cron at most once a day, 4.5 MB per request. They are frozen there:
 * their workers do not start and their actions are refused with a clear
 * message, while existing data stays readable.
 */
export const FREEZABLE_MODULES = ['reminders', 'backgroundJobs', 'dataSources', 'largeFiles'] as const;
export type FreezableModule = (typeof FREEZABLE_MODULES)[number];

const LABELS: Record<FreezableModule, string> = {
  reminders: 'Reminders',
  backgroundJobs: 'Background processing',
  dataSources: 'Data sources',
  largeFiles: 'Large files',
};

/**
 * `BRAINY_FROZEN_MODULES` lists frozen modules, comma separated ("" freezes
 * none). Without it, every module is frozen on Vercel (`VERCEL` is set
 * there) and none elsewhere.
 */
export function frozenModules(env: NodeJS.ProcessEnv = process.env): Set<FreezableModule> {
  const raw = env.BRAINY_FROZEN_MODULES;
  if (raw !== undefined) {
    const known = new Set<string>(FREEZABLE_MODULES);
    return new Set(raw.split(',').map((item) => item.trim()).filter((item): item is FreezableModule => known.has(item)));
  }
  return new Set(env.VERCEL ? FREEZABLE_MODULES : []);
}

export const isFrozen = (module: FreezableModule): boolean => frozenModules().has(module);

export function assertNotFrozen(module: FreezableModule): void {
  if (isFrozen(module)) throw new ServiceUnavailableException(`${LABELS[module]} is paused on this hosting plan`);
}

/** Attachments are sent inside the request body: base64 adds a third, so Vercel keeps 3 MiB per entry. */
export function maxEntryAttachmentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.BRAINY_MAX_ENTRY_ATTACHMENT_BYTES);
  if (Number.isInteger(configured) && configured > 0) return Math.min(configured, 8 * 1024 * 1024);
  return env.VERCEL ? 3 * 1024 * 1024 : 8 * 1024 * 1024;
}
