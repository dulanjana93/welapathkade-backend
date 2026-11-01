import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole, UserStatus, type User } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService referral rules', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  const service = new UsersService(
    prisma as never,
    { record: jest.fn() } as never,
  );

  it('rejects invalid referral codes', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.resolvePublicReferrer('MISSING'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-public referrers', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: '1',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    });
    await expect(
      service.resolvePublicReferrer('ADMIN1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts active public referrers', async () => {
    const referrer = {
      id: 'ref-1',
      role: UserRole.PUBLIC,
      status: UserStatus.ACTIVE,
    };
    prisma.user.findUnique.mockResolvedValue(referrer);
    await expect(service.resolvePublicReferrer('ABCD1234')).resolves.toEqual(
      referrer,
    );
  });
});

describe('UsersService billing profile', () => {
  const prisma = {
    user: {
      update: jest.fn(),
    },
  };
  const service = new UsersService(
    prisma as never,
    { record: jest.fn() } as never,
  );

  const customer = {
    id: 'cust-1',
    role: UserRole.PUBLIC,
    phone: '+94771234567',
    name: 'Nimal',
    email: 'admin-login@example.com',
    billingFirstName: null,
    billingLastName: null,
    billingEmail: null,
    billingAddress: null,
    billingCity: null,
    billingCountry: null,
  } as unknown as User;

  const input = {
    firstName: '  Nimal ',
    lastName: 'Perera',
    email: 'Nimal@Example.com',
    address: '12 Temple Road',
    city: 'Colombo',
    country: 'lk',
  };

  function saved(overrides: Record<string, unknown> = {}) {
    return {
      ...customer,
      billingFirstName: 'Nimal',
      billingLastName: 'Perera',
      billingEmail: 'nimal@example.com',
      billingAddress: '12 Temple Road',
      billingCity: 'Colombo',
      billingCountry: 'LK',
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an incomplete billing profile without creating records', () => {
    const view = service.getBillingProfile(customer);
    expect(view.complete).toBe(false);
    expect(view.phone).toBe('+94771234567');
    expect(view.missingFields).toEqual([
      'firstName',
      'lastName',
      'email',
      'address',
      'city',
      'country',
    ]);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('creates billing information on the authenticated customer', async () => {
    prisma.user.update.mockResolvedValue(saved());
    const view = await service.upsertBillingProfile(customer, input);
    expect(view.complete).toBe(true);
    expect(view.email).toBe('nimal@example.com');
    expect(view.country).toBe('LK');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'cust-1' },
      data: {
        billingFirstName: 'Nimal',
        billingLastName: 'Perera',
        billingEmail: 'nimal@example.com',
        billingAddress: '12 Temple Road',
        billingCity: 'Colombo',
        billingCountry: 'LK',
      },
    });
  });

  it('updates billing information without changing the account phone or login email', async () => {
    prisma.user.update.mockResolvedValue(
      saved({ billingCity: 'Kandy', billingCountry: 'Sri Lanka' }),
    );
    const view = await service.upsertBillingProfile(customer, {
      ...input,
      city: 'Kandy',
      country: 'Sri Lanka',
    });
    expect(view.city).toBe('Kandy');
    expect(view.country).toBe('Sri Lanka');
    const data = prisma.user.update.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data).not.toHaveProperty('phone');
    expect(data).not.toHaveProperty('email');
    expect(data).not.toHaveProperty('name');
  });

  it('rejects an invalid email and does not write', async () => {
    await expect(
      service.upsertBillingProfile(customer, {
        ...input,
        email: 'not-an-email',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects missing required fields and does not write', async () => {
    await expect(
      service.upsertBillingProfile(customer, {
        ...input,
        address: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('updates only the authenticated customer', async () => {
    const other = { ...customer, id: 'cust-2' } as User;
    prisma.user.update.mockResolvedValue(saved());
    await service.upsertBillingProfile(other, input);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cust-2' } }),
    );
    expect(prisma.user.update.mock.calls[0][0].where.id).not.toBe('cust-1');
  });

  it('refuses a non-public caller', async () => {
    await expect(
      service.upsertBillingProfile(
        { ...customer, role: UserRole.ASTROLOGER } as User,
        input,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
