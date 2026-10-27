import { BadRequestException } from '@nestjs/common';
import {
  parseUtcHalfOpenRange,
  prismaDateTimeFilter,
} from './admin-finance.date';

describe('parseUtcHalfOpenRange', () => {
  it('accepts open and half-open ranges', () => {
    expect(parseUtcHalfOpenRange({})).toEqual({ from: null, to: null });
    const range = parseUtcHalfOpenRange({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    });
    expect(range.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(prismaDateTimeFilter(range)).toEqual({
      gte: range.from,
      lt: range.to,
    });
  });

  it('rejects invalid and reversed ranges', () => {
    expect(() => parseUtcHalfOpenRange({ from: 'not-a-date' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      parseUtcHalfOpenRange({
        from: '2026-10-02T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      }),
    ).toThrow(/strictly before/);
    expect(() =>
      parseUtcHalfOpenRange({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      }),
    ).toThrow(BadRequestException);
  });
});
