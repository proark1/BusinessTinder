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
  console.log('[start] Running prisma migrate deploy…');
  await new Promise((resolve) => {
    const proc = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.resolve(here, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[start] prisma migrate deploy exited with code ${code} — continuing anyway.`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      console.warn(`[start] failed to spawn prisma: ${err.message} — continuing anyway.`);
      resolve();
    });
  });
}

await runMigrate();
await import('./server.js');
