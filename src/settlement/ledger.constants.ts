/** Singleton PlatformAccount.id — residual never goes to a user wallet. */
export const PLATFORM_ACCOUNT_ID = 'PLATFORM';

export function ledgerIdempotencyKey(
  snapshotId: string,
  category: string,
  kind: 'CREDIT' | 'DEBIT',
): string {
  return `snap:${snapshotId}:${category}:${kind}`;
}
