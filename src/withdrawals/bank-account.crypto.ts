import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export type EncryptedAccountNumber = {
  ciphertext: string;
  iv: string;
  tag: string;
  last4: string;
};

@Injectable()
export class BankAccountCrypto {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.getOrThrow<string>('app.bankAccountEncryptionKey');
    this.key = Buffer.from(raw, 'base64');
    if (this.key.length !== 32) {
      throw new Error('BANK_ACCOUNT_ENCRYPTION_KEY must decode to 32 bytes');
    }
  }

  encrypt(accountNumber: string): EncryptedAccountNumber {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(accountNumber, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      last4: accountNumber.slice(-4),
    };
  }

  /** Server-side only. Do not return this value from read APIs. */
  decrypt(payload: EncryptedAccountNumber): string {
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  }
}

export function maskAccountNumber(last4: string): string {
  return `••••${last4}`;
}
