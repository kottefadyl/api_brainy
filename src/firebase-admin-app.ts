// One Firebase Admin app for the API (push reminders, realtime signals, custom tokens).
import { existsSync } from 'node:fs';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';

/** True when FIREBASE_PROJECT_ID and a service account (JSON or file) are set. */
export function firebaseAdminConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.FIREBASE_PROJECT_ID?.trim()) return false;
  // Local tests with the Firebase emulators need no service account.
  if (env.FIRESTORE_EMULATOR_HOST && env.FIREBASE_AUTH_EMULATOR_HOST) return true;
  try {
    const value = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (value) {
      const account = JSON.parse(value) as { project_id?: string; client_email?: string; private_key?: string };
      return !!(account.client_email && account.private_key && account.project_id === env.FIREBASE_PROJECT_ID);
    }
    return !!env.GOOGLE_APPLICATION_CREDENTIALS?.trim() && existsSync(env.GOOGLE_APPLICATION_CREDENTIALS.trim());
  } catch { return false; }
}

export function firebaseAdminApp(name = 'brainy-admin'): App {
  const existing = getApps().find((app) => app.name === name);
  if (existing) return existing;
  const projectId = process.env.FIREBASE_PROJECT_ID!;
  const account = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  return initializeApp(account ? { projectId, credential: cert(JSON.parse(account) as Parameters<typeof cert>[0]) } : { projectId }, name);
}
