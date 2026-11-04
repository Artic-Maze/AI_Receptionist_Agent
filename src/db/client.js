import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/** @param {string} connectionString */
export function createPrisma(connectionString) {
  if (!connectionString) throw new Error('A Postgres connection string is required');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
