// Production entrypoint: run pending Prisma migrations before booting Express.
// Skips migration when DATABASE_URL is missing (in-memory fallback) so the
// server still starts in environments without a real database.
//
// PRISMA_DB_PUSH=1 also runs `prisma db push` after migrate deploy. Use this
// when the deployment doesn't track formal migrations and the schema has
// drifted (e.g. new columns added to schema.prisma). It's idempotent — a
// no-op when the live schema already matches.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '..');

function runPrisma(args, { failOnError }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['prisma', ...args], {
      cwd: backendDir,
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        const msg = `[start] prisma ${args.join(' ')} exited with code ${code}.`;
        if (failOnError) {
          console.error(`${msg} Refusing to start with a possibly-incompatible schema.`);
          return reject(new Error(`prisma ${args[0]} failed (${code})`));
        }
        console.warn(`${msg} (continuing.)`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      const msg = `[start] failed to spawn prisma: ${err.message}.`;
      if (failOnError) {
        console.error(`${msg} Refusing to start.`);
        return reject(err);
      }
      console.warn(`${msg} (continuing.)`);
      resolve();
    });
  });
}

async function runMigrate() {
  if (!process.env.DATABASE_URL && !process.env.RAILWAY_DATABASE_URL) {
    console.log('[start] No DATABASE_URL — skipping prisma migrate deploy.');
    return;
  }
  // migrate deploy is a no-op when there are no migrations on disk, so a
  // non-zero exit here means a real problem (broken connection, drift, etc).
  // Even so, don't block the server boot — surface it loudly and let the
  // operator decide whether to roll back. The server will then either work
  // (schema OK) or fail-fast on the first query that needs the missing
  // columns.
  console.log('[start] Running prisma migrate deploy…');
  await runPrisma(['migrate', 'deploy'], { failOnError: false });
}

async function runDbPush() {
  if (process.env.PRISMA_DB_PUSH !== '1') return;
  if (!process.env.DATABASE_URL && !process.env.RAILWAY_DATABASE_URL) {
    console.log('[start] PRISMA_DB_PUSH=1 but no DATABASE_URL — skipping.');
    return;
  }
  // --accept-data-loss is required so column drops (e.g. removing a now-unused
  // field from schema.prisma) actually apply. The env var is the gate — if
  // you don't want destructive changes to flow, leave PRISMA_DB_PUSH unset.
  // Best-effort: if push fails we still boot so users aren't locked out.
  console.log('[start] PRISMA_DB_PUSH=1 — running prisma db push --accept-data-loss…');
  await runPrisma(['db', 'push', '--accept-data-loss', '--skip-generate'], { failOnError: false });
}

try {
  await runMigrate();
  await runDbPush();
  await import('./server.js');
} catch (err) {
  console.error('[start] fatal:', err?.message || err);
  process.exit(1);
}
