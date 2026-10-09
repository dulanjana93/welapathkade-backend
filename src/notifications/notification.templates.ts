import type { NotificationType } from '@prisma/client';

/** Matches the Prisma `Language` enum (User.language). */
export type NotificationLanguage = 'SI' | 'EN';

export const DEFAULT_NOTIFICATION_LANGUAGE: NotificationLanguage = 'SI';

export type NotificationText = { title: string; body: string };

/**
 * Per-language copy, keyed by event type.
 *
 * Kept as plain data (no logic, no interpolation) so it can later move to
 * database-managed translations without changing callers.
 *
 * Content rules: generic only. No names, services, consultation messages,
 * decline reasons, appointment times or amounts, and nothing that says an
 * appointment is booked/confirmed except APPOINTMENT_CONFIRMED (sent only
 * after a successful payment).
 */
export const NOTIFICATION_TEMPLATES: Record<
  NotificationType,
  Record<NotificationLanguage, NotificationText>
> = {
  CONSULTATION_REQUESTED: {
    EN: {
      title: 'New consultation request',
      body: 'You have a new consultation request. Open the app to respond.',
    },
    SI: {
      title: 'නව උපදේශන ඉල්ලීමක්',
      body: 'ඔබට නව උපදේශන ඉල්ලීමක් ලැබී ඇත. ප්‍රතිචාර දැක්වීමට යෙදුම විවෘත කරන්න.',
    },
  },
  CONSULTATION_ACCEPTED: {
    EN: {
      title: 'Request accepted',
      body: 'Your consultation request was accepted. Open the app to see the next step.',
    },
    SI: {
      title: 'ඉල්ලීම පිළිගෙන ඇත',
      body: 'ඔබේ උපදේශන ඉල්ලීම පිළිගෙන ඇත. ඊළඟ පියවර බැලීමට යෙදුම විවෘත කරන්න.',
    },
  },
  CONSULTATION_DECLINED: {
    EN: {
      title: 'Request declined',
      body: 'Your consultation request was declined. Open the app to view it.',
    },
    SI: {
      title: 'ඉල්ලීම ප්‍රතික්ෂේප කර ඇත',
      body: 'ඔබේ උපදේශන ඉල්ලීම ප්‍රතික්ෂේප කර ඇත. එය බැලීමට යෙදුම විවෘත කරන්න.',
    },
  },
  PROPOSAL_CREATED: {
    EN: {
      title: 'New time proposed',
      body: 'A new time was proposed for your consultation. Open the app to review it.',
    },
    SI: {
      title: 'නව වේලාවක් යෝජනා කර ඇත',
      body: 'ඔබේ උපදේශනය සඳහා නව වේලාවක් යෝජනා කර ඇත. එය බැලීමට යෙදුම විවෘත කරන්න.',
    },
  },
  PROPOSAL_ACCEPTED: {
    EN: {
      title: 'Time proposal accepted',
      body: 'The customer accepted the proposed time. Payment is still pending.',
    },
    SI: {
      title: 'යෝජිත වේලාව පිළිගෙන ඇත',
      body: 'පාරිභෝගිකයා යෝජිත වේලාව පිළිගෙන ඇත. ගෙවීම තවමත් සිදු කර නැත.',
    },
  },
  PROPOSAL_REJECTED: {
    EN: {
      title: 'Time proposal declined',
      body: 'The customer declined the proposed time. You can propose another time.',
    },
    SI: {
      title: 'යෝජිත වේලාව ප්‍රතික්ෂේප කර ඇත',
      body: 'පාරිභෝගිකයා යෝජිත වේලාව ප්‍රතික්ෂේප කර ඇත. ඔබට වෙනත් වේලාවක් යෝජනා කළ හැක.',
    },
  },
  APPOINTMENT_CONFIRMED: {
    EN: {
      title: 'Appointment confirmed',
      body: 'The payment succeeded and the appointment is confirmed. Open the app for details.',
    },
    SI: {
      title: 'උපදේශන හමුව තහවුරු කර ඇත',
      body: 'ගෙවීම සාර්ථකයි, උපදේශන හමුව තහවුරු කර ඇත. විස්තර සඳහා යෙදුම විවෘත කරන්න.',
    },
  },
};

/** Only `EN` selects English; anything else (missing, unknown) is Sinhala. */
export function resolveNotificationLanguage(
  language: string | null | undefined,
): NotificationLanguage {
  return typeof language === 'string' && language.trim().toUpperCase() === 'EN'
    ? 'EN'
    : DEFAULT_NOTIFICATION_LANGUAGE;
}

export function renderNotificationText(
  type: NotificationType,
  language: string | null | undefined,
): NotificationText {
  const text =
    NOTIFICATION_TEMPLATES[type][resolveNotificationLanguage(language)];
  return { title: text.title, body: text.body };
}
