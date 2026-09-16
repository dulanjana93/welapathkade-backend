/**
 * Safe admin bootstrap for local/dev use.
 * Creates the initial ADMIN user if the phone is unused (or already ADMIN).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/bootstrap-admin.ts --phone +94770000000 --name "Platform Admin"
 *
 * Never expose admin signup as a public HTTP endpoint.
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
  const rawPhone = readArg('phone');
  const name = readArg('name') ?? 'Platform Admin';

  if (!rawPhone) {
    throw new Error('Missing required --phone argument');
  }

  const phone = normalizePhone(rawPhone);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const usersService = app.get(UsersService);
    const admin = await usersService.createAdminUser({ phone, name });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          message: 'Admin bootstrap complete',
          id: admin.id,
          phone: admin.phone,
          role: admin.role,
          referralCode: admin.referralCode,
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
