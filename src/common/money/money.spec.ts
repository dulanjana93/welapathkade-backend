import { toMoneyString } from './money';
import { Prisma } from '@prisma/client';

describe('money helpers', () => {
  it('serializes decimals as fixed 2-place strings', () => {
    expect(toMoneyString(new Prisma.Decimal('1000'))).toBe('1000.00');
    expect(toMoneyString('1500.5')).toBe('1500.50');
  });
});
