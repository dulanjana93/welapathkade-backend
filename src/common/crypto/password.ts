import * as argon2 from 'argon2';

const MIN_PASSWORD_LENGTH = 8;

export function assertPasswordPolicy(password: string): void {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return argon2.hash(password, { type: argon2.argon2id });
}

/** Constant-time verification via argon2.verify. */
export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

export { MIN_PASSWORD_LENGTH };
