// Production entrypoint: run pending Prisma migrations before booting Express.
// Skips migration when DATABASE_URL is missing (in-memory fallback) so the
// server still starts in environments without a real database.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

async function runMigrate() {
  if (!process.env.DATABASE_URL && !process.env.RAILWAY_DATABASE_URL) {
    console.log('[start] No DATABASE_URL — skipping prisma migrate deploy.');
    return;
  }
  const isProd = process.env.NODE_ENV === 'production';
  console.log('[start] Running prisma migrate deploy…');
  await new Promise((resolve, reject) => {
    const proc = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.resolve(here, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        const msg = `[start] prisma migrate deploy exited with code ${code}.`;
        if (isProd) {
          console.error(`${msg} Refusing to start with a possibly-incompatible schema.`);
          return reject(new Error(`migrate deploy failed (${code})`));
        }
        console.warn(`${msg} (dev mode — continuing so you can iterate on the schema.)`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      const msg = `[start] failed to spawn prisma: ${err.message}.`;
      if (isProd) {
        console.error(`${msg} Refusing to start.`);
        return reject(err);
      }
      console.warn(`${msg} (dev mode — continuing.)`);
      resolve();
    });
  });
}

try {
  await runMigrate();
  await import('./server.js');
} catch (err) {
  console.error('[start] fatal:', err?.message || err);
  process.exit(1);
}
