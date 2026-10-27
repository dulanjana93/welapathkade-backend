import { Prisma } from '@prisma/client';

/** API money representation — decimal string, never a JS float calculation source. */
export type MoneyString = string;

export function toMoneyString(
  value: Prisma.Decimal | string | number,
): MoneyString {
  if (value instanceof Prisma.Decimal) {
    return value.toFixed(2);
  }
  return new Prisma.Decimal(value).toFixed(2);
}

export function toDecimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function isPriceWithinRange(
  price: Prisma.Decimal,
  minPrice: Prisma.Decimal,
  maxPrice: Prisma.Decimal,
): boolean {
  return (
    price.greaterThanOrEqualTo(minPrice) && price.lessThanOrEqualTo(maxPrice)
  );
}
