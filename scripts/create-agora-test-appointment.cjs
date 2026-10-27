/**
 * Development-only helper: walk the real consultation → propose → pay flow
 * and produce a CONFIRMED appointment eligible for Agora join testing.
 *
 * Guards:
 *   - Aborts unless NODE_ENV is exactly "development" or "test"
 *   - Never runs mock payment finalize outside that allowlist (API also enforces)
 *   - Optional join-window shift only with --shift-join-window and non-production
 *
 * Usage (from welapathkade-api/):
 *   node scripts/create-agora-test-appointment.cjs \
 *     --customer-phone +9477XXXXXXX --customer-otp 123456 \
 *     --astrologer-phone +9477YYYYYYY --astrologer-otp 654321 \
 *     [--shift-join-window]
 *
 * Request OTPs first in each app (or via POST /auth/otp/request), then pass codes.
 * Prefer --shift-join-window for an immediately joinable appointment; otherwise
 * the proposed start respects API minLeadMinutes (60, or 5 when
 * ALLOW_SHORT_NOTICE_TEST_APPOINTMENTS=true).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const { DateTime } = require('luxon');

const BASE = process.env.API_BASE_URL || 'http://127.0.0.1:3010';
const NODE_ENV = process.env.NODE_ENV || '';
const BUSINESS_TZ = 'Asia/Colombo';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(
      `${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loginWithOptionalRequest(phone, otp, requestOtp) {
  if (requestOtp) {
    await http('POST', '/auth/otp/request', {
      body: { phone, purpose: 'LOGIN' },
    });
    fail(
      `[otp] requested LOGIN for ${phone}. Read [DEV OTP] from the API console, then re-run with --customer-otp/--astrologer-otp and WITHOUT --request-otp.`,
    );
  }
  return http('POST', '/auth/otp/verify', {
    body: { phone, code: otp },
  });
}

async function main() {
  if (NODE_ENV !== 'development' && NODE_ENV !== 'test') {
    fail(
      `Refusing to run: NODE_ENV=${JSON.stringify(NODE_ENV)} (need development|test)`,
    );
  }

  const customerPhone = arg('--customer-phone');
  const customerOtp = arg('--customer-otp');
  const astrologerPhone = arg('--astrologer-phone');
  const astrologerOtp = arg('--astrologer-otp');
  const requestOtp = hasFlag('--request-otp');
  const shiftJoin = hasFlag('--shift-join-window');

  if (!customerPhone || !astrologerPhone) {
    fail('Required: --customer-phone --astrologer-phone');
  }
  if (!requestOtp && (!customerOtp || !astrologerOtp)) {
    fail(
      'Required: --customer-otp --astrologer-otp (or pass --request-otp once to print codes)',
    );
  }

  console.log(`[env] NODE_ENV=${NODE_ENV} BASE=${BASE}`);

  const customerSession = await loginWithOptionalRequest(
    customerPhone,
    customerOtp,
    requestOtp,
  );
  const astroSession = await loginWithOptionalRequest(
    astrologerPhone,
    astrologerOtp,
    requestOtp,
  );
  const customerToken = customerSession.accessToken;
  const astroToken = astroSession.accessToken;

  const meAstro = await http('GET', '/auth/me', { token: astroToken });
  let profileId =
    meAstro.astrologerProfileId ||
    meAstro.astrologerProfile?.id ||
    meAstro.profile?.id ||
    meAstro.astrologerId;
  if (!profileId) {
    const prisma = new PrismaClient();
    try {
      const row = await prisma.astrologerProfile.findFirst({
        where: { user: { phone: astrologerPhone } },
        select: { id: true },
      });
      profileId = row?.id;
    } finally {
      await prisma.$disconnect();
    }
  }
  if (!profileId) {
    fail(
      `Could not resolve astrologer profile id from /auth/me: ${JSON.stringify(meAstro)}`,
    );
  }

  const services = await http('GET', `/astrologers/${profileId}`, {
    token: customerToken,
  });
  const offer =
    (services.services || []).find((s) => s.status === 'ACTIVE') ||
    (services.services || [])[0];
  if (!offer) fail('Astrologer has no services');
  const serviceId = offer.serviceId || offer.id;

  const from = DateTime.now().setZone(BUSINESS_TZ).plus({ days: 1 }).toISODate();
  const to = DateTime.now().setZone(BUSINESS_TZ).plus({ days: 7 }).toISODate();
  const slotsRes = await http(
    'GET',
    `/astrologers/${profileId}/availability/slots?from=${from}&to=${to}&durationMinutes=30`,
    { token: customerToken },
  );
  const slots = slotsRes.slots || [];
  if (!slots.length) {
    fail('No public slots in the next week — set weekly availability first');
  }

  // Prefer a slot that satisfies the API lead (60m, or 5m under short-notice override).
  const nowMs = Date.now();
  const minLeadMinutes = Number(slotsRes.minLeadMinutes) || 60;
  const minLeadMs = (minLeadMinutes + 1) * 60 * 1000;
  console.log(
    `[lead] minLeadMinutes=${minLeadMinutes}` +
      (slotsRes.shortNoticeTestAppointments
        ? ' (short-notice test override)'
        : ''),
  );
  const slot =
    slots.find((s) => new Date(s.startAt).getTime() >= nowMs + minLeadMs) ||
    slots[0];

  // Preference window = same local afternoon range overlapping availability (not duration).
  const prefStart = slot.startAt;
  const prefEnd = DateTime.fromISO(slot.startAt)
    .plus({ hours: 2 })
    .toUTC()
    .toISO();

  const created = await http('POST', '/consultations', {
    token: customerToken,
    body: {
      astrologerId: profileId,
      serviceId,
      preferredStartAt: prefStart,
      preferredEndAt: prefEnd,
      message: 'Agora MVP test request (auto)',
    },
  });
  console.log(`[ok] consultation ${created.id}`);

  await http('POST', `/astrologers/me/consultations/${created.id}/accept`, {
    token: astroToken,
  });
  console.log('[ok] accepted');

  const proposal = await http(
    'POST',
    `/astrologers/me/consultations/${created.id}/proposals`,
    {
      token: astroToken,
      body: {
        proposedStartAt: slot.startAt,
        durationMinutes: 30,
      },
    },
  );
  console.log(`[ok] proposal ${proposal.id} start=${slot.startAt}`);

  await http(
    'POST',
    `/consultations/${created.id}/proposals/${proposal.id}/accept`,
    { token: customerToken },
  );
  console.log('[ok] proposal accepted');

  const checkout = await http(
    'POST',
    `/consultations/${created.id}/proposals/${proposal.id}/checkout`,
    { token: customerToken },
  );
  const merchantReference =
    checkout.appointment?.payment?.latestAttempt?.merchantReference;
  const amount = checkout.appointment?.amount || '0.00';
  if (!merchantReference) fail('Checkout missing merchantReference');
  console.log(`[ok] checkout appointment=${checkout.appointment.id}`);

  const paid = await http('POST', '/payments/callbacks/mock', {
    body: {
      merchantReference,
      success: true,
      amount: String(amount),
      currency: 'LKR',
    },
  });
  console.log(`[ok] paid status=${paid.appointment?.status}`);

  let appointmentId = paid.appointment?.id || checkout.appointment.id;
  let startAt = paid.appointment?.startAt || slot.startAt;
  let endAt = paid.appointment?.endAt;

  if (shiftJoin) {
    const prisma = new PrismaClient();
    try {
      const newStart = DateTime.now().plus({ minutes: 3 }).toUTC();
      const newEnd = newStart.plus({ minutes: 30 });
      await prisma.$transaction(async (tx) => {
        await tx.consultationProposal.update({
          where: { id: proposal.id },
          data: {
            proposedStartAt: newStart.toJSDate(),
            proposedEndAt: newEnd.toJSDate(),
          },
        });
        await tx.appointment.update({
          where: { id: appointmentId },
          data: {
            startAt: newStart.toJSDate(),
            endAt: newEnd.toJSDate(),
          },
        });
      });
      startAt = newStart.toISO();
      endAt = newEnd.toISO();
      console.log(
        `[ok] shifted into join window (dev only): startAt=${startAt} (in ~3 minutes; join opens ~7 minutes before start… wait, join is start-10m so open immediately)`,
      );
      // Join window is [start-10m, start+10m]. start=now+3m ⇒ already inside window.
    } finally {
      await prisma.$disconnect();
    }
  }

  const detail = await http('GET', `/consultations/${created.id}`, {
    token: customerToken,
  });

  console.log(
    JSON.stringify(
      {
        consultationId: created.id,
        appointmentId,
        proposalId: proposal.id,
        startAt,
        endAt,
        canJoinVideoSession: detail.actionability?.canJoinVideoSession,
        stage: detail.actionability?.stage,
        customerPhone,
        astrologerPhone,
        nextSteps: [
          'Open customer app → consultation detail → Join when canJoinVideoSession is true',
          'Open astrologer app → same consultation → Join',
          shiftJoin
            ? 'Times were shifted for immediate join (dev only)'
            : 'Wait until start-10m for join window, or re-run with --shift-join-window',
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
