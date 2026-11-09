// Loads api/.env for local runs. Must stay the first import of main.ts: modules read
// process.env while they load. Variables already set by the host are never overridden.
import { join } from 'node:path';

try {
  process.loadEnvFile(join(__dirname, '..', '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
