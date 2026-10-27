import { BadRequestException } from '@nestjs/common';
import { ConsultationFileType } from '@prisma/client';
import {
  consultationRequestFingerprint,
  parseConsultationIdempotencyKey,
} from './consultation-idempotency';

const base = {
  astrologerId: 'ap-1',
  serviceId: 'svc-1',
  preferredStartAt: new Date('2026-09-20T04:30:00.000Z'),
  preferredEndAt: null,
  message: 'hello',
  files: [{ fileId: 'file-1', type: ConsultationFileType.IMAGE }],
};

describe('consultation idempotency key', () => {
  it('accepts a stable client key and rejects a short one', () => {
    expect(parseConsultationIdempotencyKey(undefined)).toBeNull();
    expect(parseConsultationIdempotencyKey('   ')).toBeNull();
    expect(parseConsultationIdempotencyKey('  retry-key-01  ')).toBe(
      'retry-key-01',
    );
    expect(() => parseConsultationIdempotencyKey('short')).toThrow(
      BadRequestException,
    );
  });

  it('hashes the logical payload and ignores surrounding message space only after trim', () => {
    const first = consultationRequestFingerprint(base);
    expect(consultationRequestFingerprint({ ...base })).toBe(first);
    expect(
      consultationRequestFingerprint({
        ...base,
        message: 'a different note',
      }),
    ).not.toBe(first);
    expect(
      consultationRequestFingerprint({
        ...base,
        files: [
          { fileId: 'file-2', type: ConsultationFileType.IMAGE },
          { fileId: 'file-1', type: ConsultationFileType.IMAGE },
        ],
      }),
    ).not.toBe(first);
  });
});
