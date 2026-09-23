/**
 * Safely create welapathkade_test in the existing MySQL container.
 * Does NOT drop, truncate, or modify the development database (welapathkade).
 *
 * Usage: npm run test:e2e:setup
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CONTAINER = 'welapathkade-mysql';
const TEST_DB = 'welapathkade_test';
const DEV_DB = 'welapathkade';

function run(cmd, opts = {}) {
  return execSync(cmd, {
    stdio: opts.silent ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...opts,
  });
}

console.log('[e2e-setup] Creating isolated test database (will not touch welapathkade)...');

try {
  run(`docker exec ${CONTAINER} mysqladmin ping -h localhost -uroot -proot --silent`, {
    silent: true,
  });
} catch {
  console.error(
    `[e2e-setup] MySQL container "${CONTAINER}" is not reachable. Start it with: docker compose up -d`,
  );
  process.exit(1);
}

const sql = [
  `CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  `GRANT ALL PRIVILEGES ON \`${TEST_DB}\`.* TO 'welapathkade'@'%';`,
  `FLUSH PRIVILEGES;`,
  `SHOW DATABASES LIKE 'welapathkade%';`,
].join(' ');

run(
  `docker exec ${CONTAINER} mysql -uroot -proot -e "${sql}"`,
);

const envExample = path.join(__dirname, '..', '.env.test.example');
const envTest = path.join(__dirname, '..', '.env.test');
if (!fs.existsSync(envTest) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envTest);
  console.log('[e2e-setup] Created .env.test from .env.test.example');
}

console.log(`[e2e-setup] Applying Prisma migrations to ${TEST_DB} only...`);
run(`node -r ${path.join(__dirname, 'load-env-test.cjs')} ./node_modules/prisma/build/index.js migrate deploy`, {
  cwd: path.join(__dirname, '..'),
});

console.log('[e2e-setup] Migration status (test DB):');
run(`node -r ${path.join(__dirname, 'load-env-test.cjs')} ./node_modules/prisma/build/index.js migrate status`, {
  cwd: path.join(__dirname, '..'),
});

console.log(`[e2e-setup] Done. Development DB "${DEV_DB}" was not modified.`);
console.log('[e2e-setup] Next: npm run test:e2e');
