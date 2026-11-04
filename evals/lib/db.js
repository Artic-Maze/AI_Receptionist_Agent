import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createPrisma } from '../../src/db/client.js';
import { config } from '../../src/config.js';

const run = promisify(execFile);

/** Evals wipe every table, so they refuse any database not named as a test one. */
export function assertTestDatabase(url) {
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run against "${name}": the database name must end in _test`);
  }
  return url;
}

export function createTestPrisma() {
  return createPrisma(assertTestDatabase(config.testDatabaseUrl));
}

/** Applies migrations to the test database, once per run. */
export async function migrateTestDatabase() {
  const url = assertTestDatabase(config.testDatabaseUrl);
  await run('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url } });
}

/**
 * Empties the test database between scenarios. audit_log's trigger rejects TRUNCATE,
 * as it should, so it is switched off for this one statement. Doing this needs table
 * ownership, which is why production's application role should not own that table.
 */
export async function resetDatabase(prisma) {
  assertTestDatabase(config.testDatabaseUrl);
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate'),
    prisma.$executeRawUnsafe(
      'TRUNCATE audit_log, handoffs, tool_calls, messages, conversations, patients RESTART IDENTITY CASCADE',
    ),
    prisma.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_truncate'),
  ]);
}
