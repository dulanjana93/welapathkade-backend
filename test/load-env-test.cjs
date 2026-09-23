/**
 * Loaded via `node -r ./test/load-env-test.cjs` before Jest/Prisma.
 * Forces .env.test over any ambient/development DATABASE_URL.
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '..', '.env.test');

if (!fs.existsSync(envPath)) {
  console.error(
    `[e2e] Missing ${envPath}. Copy .env.test.example to .env.test and run npm run test:e2e:setup.`,
  );
  process.exit(1);
}

const result = dotenv.config({ path: envPath, override: true });
if (result.error) {
  console.error('[e2e] Failed to load .env.test:', result.error.message);
  process.exit(1);
}

process.env.NODE_ENV = 'test';

function parseMysqlDatabaseName(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    const normalized = String(databaseUrl).trim().replace(/^mysql:/i, 'http:');
    const url = new URL(normalized);
    return decodeURIComponent(url.pathname.replace(/^\//, '')) || null;
  } catch {
    const match = String(databaseUrl).match(/\/([^/?]+)(\?|$)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

function parseHostPort(databaseUrl) {
  try {
    const normalized = String(databaseUrl).trim().replace(/^mysql:/i, 'http:');
    const url = new URL(normalized);
    return { host: url.hostname, port: url.port || '?' };
  } catch {
    return { host: '?', port: '?' };
  }
}

const dbName = parseMysqlDatabaseName(process.env.DATABASE_URL);
if (dbName !== 'welapathkade_test') {
  console.error(
    `[e2e] REFUSING TO START: DATABASE_URL must target welapathkade_test (got "${dbName ?? 'unknown'}")`,
  );
  process.exit(1);
}

const { host, port } = parseHostPort(process.env.DATABASE_URL);
console.log('[e2e] E2E database:');
console.log(`host=${host}`);
console.log(`port=${port}`);
console.log(`database=${dbName}`);
