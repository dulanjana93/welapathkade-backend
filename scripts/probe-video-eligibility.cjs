/* Read-only probe: list CONFIRMED/IN_PROGRESS appointments and join-window eligibility. */
require('dotenv').config({ path: '.env' });
const { PrismaClient, AppointmentStatus } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  const joinBeforeMs = 10 * 60 * 1000;
  const graceMs = 10 * 60 * 1000;
  const endBufferMs = 5 * 60 * 1000;

  const rows = await prisma.appointment.findMany({
    where: {
      status: {
        in: [AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS],
      },
    },
    select: {
      id: true,
      consultationId: true,
      status: true,
      startAt: true,
      endAt: true,
      customerId: true,
      astrologerId: true,
      customer: { select: { phone: true } },
      astrologer: {
        select: { user: { select: { phone: true } } },
      },
    },
    orderBy: { startAt: 'asc' },
    take: 40,
  });

  const mapped = rows.map((a) => {
    const t = now.getTime();
    const s = a.startAt.getTime();
    const e = a.endAt.getTime();
    let inWindow = false;
    if (a.status === AppointmentStatus.CONFIRMED) {
      inWindow = t >= s - joinBeforeMs && t <= s + graceMs;
    } else if (a.status === AppointmentStatus.IN_PROGRESS) {
      inWindow = t >= s - joinBeforeMs && t <= e + endBufferMs;
    }
    return {
      appointmentId: a.id,
      consultationId: a.consultationId,
      status: a.status,
      startAt: a.startAt.toISOString(),
      endAt: a.endAt.toISOString(),
      minutesToStart: Math.round((s - t) / 60000),
      inCredentialWindow: inWindow,
      customerPhoneLast4: a.customer?.phone
        ? String(a.customer.phone).slice(-4)
        : null,
      astrologerPhoneLast4: a.astrologer?.user?.phone
        ? String(a.astrologer.user.phone).slice(-4)
        : null,
    };
  });

  const eligibleNow = mapped.filter((x) => x.inCredentialWindow);
  process.stdout.write(
    JSON.stringify(
      {
        now: now.toISOString(),
        confirmedOrInProgressCount: rows.length,
        eligibleNowCount: eligibleNow.length,
        nearest: mapped.slice(0, 12),
        eligibleNow,
      },
      null,
      2,
    ) + '\n',
  );
}

main()
  .catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
