/**
 * Read-only live probe of video-session endpoints.
 * Never prints App Certificate or RTC tokens.
 *
 * Usage:
 *   node scripts/probe-video-endpoint.cjs
 *
 * Reads phone + OTP flow from console SMS (dev). Requires start:dev running.
 */
require('dotenv').config({ path: '.env' });
const { PrismaClient } = require('@prisma/client');

const BASE = `http://127.0.0.1:${Number(process.env.PORT || 3010)}`;
const prisma = new PrismaClient();

async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 120) };
  }
  return { status: res.status, data };
}

function summarizeCredentials(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    provider: data.provider ?? null,
    hasAppId: typeof data.appId === 'string' && data.appId.length > 0,
    appIdLength: typeof data.appId === 'string' ? data.appId.length : 0,
    channelName: data.channelName ?? null,
    uid: data.uid ?? null,
    hasToken: typeof data.token === 'string' && data.token.length > 20,
    tokenLength: typeof data.token === 'string' ? data.token.length : 0,
    participantRole: data.participantRole ?? null,
    hasTokenExpiresAt: !!data.tokenExpiresAt,
    leakedCertificate:
      Object.prototype.hasOwnProperty.call(data, 'appCertificate') ||
      Object.prototype.hasOwnProperty.call(data, 'AGORA_APP_CERTIFICATE') ||
      /certificate/i.test(JSON.stringify(data)),
  };
}

const fs = require('fs');
const path = require('path');

function readDevOtpFromNestTerminal(phone) {
  const terminalsDir =
    process.env.CURSOR_TERMINALS_DIR ||
    path.join(
      process.env.USERPROFILE || '',
      '.cursor',
      'projects',
      'd-Personal-Projects-welapathkade-lk',
      'terminals',
    );
  let files = [];
  try {
    files = fs
      .readdirSync(terminalsDir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => path.join(terminalsDir, f));
  } catch {
    return null;
  }
  const escaped = phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\[DEV OTP\\] phone=${escaped} purpose=(\\w+) code=(\\d+)`,
  );
  let best = null;
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const matches = [...text.matchAll(new RegExp(re, 'g'))];
    if (matches.length) {
      const last = matches[matches.length - 1];
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { code: last[2], purpose: last[1], mtimeMs: stat.mtimeMs };
      }
    }
  }
  return best?.code ?? null;
}

async function login(phone, purpose) {
  const req = await http('POST', '/auth/otp/request', {
    body: { phone, purpose },
  });
  if (req.status >= 400) {
    return { ok: false, step: 'otp/request', status: req.status, data: req.data };
  }

  // Wait briefly for ConsoleSmsSender to flush into the Nest terminal log.
  await new Promise((r) => setTimeout(r, 800));
  const otp = readDevOtpFromNestTerminal(phone);
  if (!otp) {
    return {
      ok: false,
      step: 'otp',
      status: 0,
      data: {
        message:
          'Could not read DEV OTP from Nest terminal log ([DEV OTP]).',
      },
    };
  }

  const verify = await http('POST', '/auth/otp/verify', {
    body: { phone, code: otp },
  });
  if (verify.status >= 400 || !verify.data?.accessToken) {
    return {
      ok: false,
      step: 'otp/verify',
      status: verify.status,
      data: { message: verify.data?.message ?? 'verify failed' },
    };
  }
  return {
    ok: true,
    accessToken: verify.data.accessToken,
    role: verify.data.user?.role ?? null,
  };
}

async function main() {
  const health = await http('GET', '/health');
  const apt = await prisma.appointment.findFirst({
    where: { status: 'CONFIRMED' },
    orderBy: { startAt: 'desc' },
    select: {
      consultationId: true,
      status: true,
      startAt: true,
      customer: { select: { phone: true, role: true } },
      astrologer: {
        select: { user: { select: { phone: true, role: true } } },
      },
    },
  });

  const report = {
    base: BASE,
    healthStatus: health.status,
    hasConfirmedAppointment: !!apt,
    consultationId: apt?.consultationId ?? null,
    appointmentStatus: apt?.status ?? null,
    startAt: apt?.startAt?.toISOString() ?? null,
  };

  if (!apt?.customer?.phone) {
    process.stdout.write(
      JSON.stringify({ ...report, error: 'no_customer_phone' }, null, 2) +
        '\n',
    );
    return;
  }

  // Unauthenticated call
  const unauth = await http(
    'POST',
    `/consultations/${apt.consultationId}/appointment/video-session`,
  );
  report.unauthenticatedStatus = unauth.status;

  const customerLogin = await login(apt.customer.phone, 'LOGIN');
  report.customerLoginOk = customerLogin.ok;
  report.customerLoginStep = customerLogin.step ?? null;
  report.customerLoginStatus = customerLogin.status ?? null;
  report.customerRole = customerLogin.role ?? null;

  if (customerLogin.ok) {
    const customerCall = await http(
      'POST',
      `/consultations/${apt.consultationId}/appointment/video-session`,
      { token: customerLogin.accessToken },
    );
    report.customerVideoStatus = customerCall.status;
    report.customerVideoMessage =
      customerCall.data?.message ??
      customerCall.data?.error ??
      (customerCall.status === 200 ? 'ok' : null);
    if (customerCall.status === 200) {
      report.customerCreds = summarizeCredentials(customerCall.data);
    }
  }

  const astroPhone = apt.astrologer?.user?.phone;
  const samePhone =
    !!astroPhone && !!apt.customer?.phone && astroPhone === apt.customer.phone;
  report.customerAndAstrologerSharePhone = samePhone;
  if (astroPhone && !samePhone) {
    const astroLogin = await login(astroPhone, 'LOGIN');
    report.astrologerLoginOk = astroLogin.ok;
    report.astrologerLoginStep = astroLogin.step ?? null;
    report.astrologerLoginStatus = astroLogin.status ?? null;
    report.astrologerRole = astroLogin.role ?? null;
    if (astroLogin.ok) {
      const astroCall = await http(
        'POST',
        `/astrologers/me/consultations/${apt.consultationId}/appointment/video-session`,
        { token: astroLogin.accessToken },
      );
      report.astrologerVideoStatus = astroCall.status;
      report.astrologerVideoMessage =
        astroCall.data?.message ??
        astroCall.data?.error ??
        (astroCall.status === 200 ? 'ok' : null);
      if (astroCall.status === 200) {
        report.astrologerCreds = summarizeCredentials(astroCall.data);
      }
    }
  } else if (samePhone && customerLogin.ok && customerLogin.role === 'ASTROLOGER') {
    const astroCall = await http(
      'POST',
      `/astrologers/me/consultations/${apt.consultationId}/appointment/video-session`,
      { token: customerLogin.accessToken },
    );
    report.astrologerVideoStatus = astroCall.status;
    report.astrologerVideoMessage =
      astroCall.data?.message ??
      astroCall.data?.error ??
      (astroCall.status === 200 ? 'ok' : null);
  }

  // Interpretation helpers (no secrets)
  report.interpretation = {
    agoraConfiguredOnLivePath:
      report.customerVideoStatus === 200 ||
      report.customerVideoStatus === 409 ||
      report.astrologerVideoStatus === 200 ||
      report.astrologerVideoStatus === 409,
    agoraMissingWouldBe503:
      report.customerVideoStatus === 503 ||
      report.astrologerVideoStatus === 503,
    fullJoinVerified:
      report.customerVideoStatus === 200 &&
      report.astrologerVideoStatus === 200 &&
      report.customerCreds?.channelName &&
      report.customerCreds.channelName === report.astrologerCreds?.channelName &&
      report.customerCreds.uid !== report.astrologerCreds?.uid &&
      report.customerCreds.hasToken &&
      report.astrologerCreds.hasToken &&
      !report.customerCreds.leakedCertificate &&
      !report.astrologerCreds.leakedCertificate,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main()
  .catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
