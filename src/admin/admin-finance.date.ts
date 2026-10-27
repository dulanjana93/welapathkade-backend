import { BadRequestException } from '@nestjs/common';

export type UtcHalfOpenRange = {
  from: Date | null;
  to: Date | null;
};

/**
 * Parse optional ISO timestamps into a UTC half-open interval [from, to).
 * Either bound may be omitted. Rejects invalid or reversed ranges.
 */
export function parseUtcHalfOpenRange(params: {
  from?: string;
  to?: string;
}): UtcHalfOpenRange {
  const from = params.from ? new Date(params.from) : null;
  const to = params.to ? new Date(params.to) : null;

  if (from && Number.isNaN(from.getTime())) {
    throw new BadRequestException('Invalid from timestamp');
  }
  if (to && Number.isNaN(to.getTime())) {
    throw new BadRequestException('Invalid to timestamp');
  }
  if (from && to && from.getTime() >= to.getTime()) {
    throw new BadRequestException(
      'Invalid date range: from must be strictly before to (half-open UTC interval)',
    );
  }
  return { from, to };
}

/** Prisma DateTime filter fragment for half-open [from, to). */
export function prismaDateTimeFilter(range: UtcHalfOpenRange): {
  gte?: Date;
  lt?: Date;
} {
  return {
    ...(range.from ? { gte: range.from } : {}),
    ...(range.to ? { lt: range.to } : {}),
  };
}

export function hasDateBound(range: UtcHalfOpenRange): boolean {
  return range.from != null || range.to != null;
}
