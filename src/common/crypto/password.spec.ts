import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword('SecretPass1');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('SecretPass1');
    await expect(verifyPassword(hash, 'SecretPass1')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'other')).resolves.toBe(false);
  });

  it('rejects short passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 8/);
  });
});
