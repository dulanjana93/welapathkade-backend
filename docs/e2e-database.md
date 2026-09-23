# E2E database isolation

## Why

E2E tests wipe tables with `deleteMany` in `beforeEach`. Those cleanups must
**never** run against the development database.

## Databases

| Environment | Database name | How it is selected |
|---|---|---|
| Development (`npm run start:dev`) | `welapathkade` | `.env` → `DATABASE_URL` |
| E2E (`npm run test:e2e`) | `welapathkade_test` | `.env.test` forced via `test/load-env-test.cjs` |

Both databases live in the same MySQL container (`localhost:3307`). They are
completely separate schemas.

## Safety rules

1. Never set development `DATABASE_URL` to `welapathkade_test`.
2. Never set E2E `DATABASE_URL` to `welapathkade`.
3. Destructive E2E cleanup calls `assertTestDatabase()` first and refuses unless:
   - `NODE_ENV === "test"`
   - `DATABASE_URL` is set
   - database name is exactly `welapathkade_test`
4. Do **not** run `prisma migrate reset`, `DROP DATABASE welapathkade`, or
   `docker compose down -v` to “fix” E2E issues.

## Developer commands

```bash
# One-time / when migrations change
npm run test:e2e:setup

# Run E2E (always uses welapathkade_test)
npm run test:e2e

# Apply migrations to test DB only (without recreating DB)
npm run test:e2e:migrate
```

Copy `.env.test.example` → `.env.test` if `.env.test` is missing (setup does this).
