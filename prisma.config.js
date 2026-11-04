import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // A placeholder keeps `prisma generate` working without a database; commands
  // that actually connect fail loudly if the real value is missing.
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://unset/unset' },
});
