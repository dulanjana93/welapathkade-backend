/**
 * Safe admin bootstrap for local/dev use.
 * Creates or updates an ADMIN user with email + password (Argon2id).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/bootstrap-admin.ts \
 *     --email admin@welapathkade.local \
 *     --password "ChangeMeNow!" \
 *     --name "Platform Admin"
 *
 * Optional:
 *   --phone +9477XXXXXXX   (legacy; otherwise a synthetic phone is assigned)
 *
 * Password may also be supplied via ADMIN_BOOTSTRAP_PASSWORD env var.
 * Never expose admin signup as a public HTTP endpoint.
 * Never prints the password.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { normalizePhone } from '../common/phone/normalize-phone';
import { UsersService } from '../users/users.service';

function readArg(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main() {
  const email = readArg('email');
  const password =
    readArg('password') ?? process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const name = readArg('name') ?? 'Platform Admin';
  const rawPhone = readArg('phone');

  if (!email?.trim()) {
    throw new Error('Missing required --email argument');
  }
  if (!password) {
    throw new Error(
      'Missing password: pass --password or set ADMIN_BOOTSTRAP_PASSWORD',
    );
  }

  const phone = rawPhone ? normalizePhone(rawPhone) : undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const usersService = app.get(UsersService);
    const admin = await usersService.createAdminUser({
      email,
      password,
      name,
      phone,
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          message: 'Admin bootstrap complete',
          id: admin.id,
          email: admin.email,
          role: admin.role,
          status: admin.status,
          // intentionally omit password / passwordHash / tokens
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
