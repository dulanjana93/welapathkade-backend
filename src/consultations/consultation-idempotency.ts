import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { ConsultationFileType, Prisma } from '@prisma/client';

export const CONSULTATION_IDEMPOTENCY_CONFLICT =
  'This submission key was already used for a different consultation request';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,80}$/;

export function parseConsultationIdempotencyKey(raw?: string): string | null {
  if (raw == null || raw.trim() === '') return null;
  const key = raw.trim();
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestException('INVALID_IDEMPOTENCY_KEY');
  }
  return key;
}

export type ConsultationSubmissionFingerprintInput = {
  astrologerId: string;
  serviceId: string;
  preferredStartAt: Date;
  preferredEndAt: Date | null;
  message: string | null;
  files: Array<{ fileId: string; type: ConsultationFileType }>;
};

/** Stable hash of the logical create payload. Timestamps and price snapshots are excluded. */
export function consultationRequestFingerprint(
  input: ConsultationSubmissionFingerprintInput,
): string {
  const canonical = JSON.stringify({
    astrologerId: input.astrologerId,
    serviceId: input.serviceId,
    preferredStartAt: input.preferredStartAt.toISOString(),
    preferredEndAt: input.preferredEndAt?.toISOString() ?? null,
    message: input.message,
    files: input.files.map((file) => ({
      fileId: file.fileId,
      type: file.type,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function isPrismaUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
