import { NotificationType } from '@prisma/client';
import {
  DEFAULT_NOTIFICATION_LANGUAGE,
  NOTIFICATION_TEMPLATES,
  renderNotificationText,
  resolveNotificationLanguage,
} from './notification.templates';

const APPROVED_TITLES: Record<NotificationType, { EN: string; SI: string }> = {
  CONSULTATION_REQUESTED: {
    EN: 'New consultation request',
    SI: 'නව උපදේශන ඉල්ලීමක්',
  },
  CONSULTATION_ACCEPTED: {
    EN: 'Request accepted',
    SI: 'ඉල්ලීම පිළිගෙන ඇත',
  },
  CONSULTATION_DECLINED: {
    EN: 'Request declined',
    SI: 'ඉල්ලීම ප්‍රතික්ෂේප කර ඇත',
  },
  PROPOSAL_CREATED: {
    EN: 'New time proposed',
    SI: 'නව වේලාවක් යෝජනා කර ඇත',
  },
  PROPOSAL_ACCEPTED: {
    EN: 'Time proposal accepted',
    SI: 'යෝජිත වේලාව පිළිගෙන ඇත',
  },
  PROPOSAL_REJECTED: {
    EN: 'Time proposal declined',
    SI: 'යෝජිත වේලාව ප්‍රතික්ෂේප කර ඇත',
  },
  APPOINTMENT_CONFIRMED: {
    EN: 'Appointment confirmed',
    SI: 'උපදේශන හමුව තහවුරු කර ඇත',
  },
};

const ALL_TYPES = Object.values(NotificationType);
const LANGUAGES = ['EN', 'SI'] as const;

describe('notification templates', () => {
  it('cover every notification type in both languages', () => {
    expect(ALL_TYPES).toHaveLength(7);
    for (const type of ALL_TYPES) {
      for (const lang of LANGUAGES) {
        const text = NOTIFICATION_TEMPLATES[type][lang];
        expect(text.title.trim()).not.toBe('');
        expect(text.body.trim()).not.toBe('');
      }
    }
  });

  it.each(ALL_TYPES)('%s uses the approved titles', (type) => {
    expect(renderNotificationText(type, 'EN').title).toBe(
      APPROVED_TITLES[type].EN,
    );
    expect(renderNotificationText(type, 'SI').title).toBe(
      APPROVED_TITLES[type].SI,
    );
  });

  it.each(ALL_TYPES)('%s fits the stored column limits', (type) => {
    for (const lang of LANGUAGES) {
      const { title, body } = NOTIFICATION_TEMPLATES[type][lang];
      expect(title.length).toBeLessThanOrEqual(160);
      expect(body.length).toBeLessThanOrEqual(500);
    }
  });

  it('Sinhala differs from English for every event', () => {
    for (const type of ALL_TYPES) {
      expect(NOTIFICATION_TEMPLATES[type].SI.title).not.toBe(
        NOTIFICATION_TEMPLATES[type].EN.title,
      );
      expect(NOTIFICATION_TEMPLATES[type].SI.body).not.toBe(
        NOTIFICATION_TEMPLATES[type].EN.body,
      );
    }
  });

  it('PROPOSAL_ACCEPTED states acceptance with payment still pending (exact approved bodies)', () => {
    expect(renderNotificationText('PROPOSAL_ACCEPTED', 'EN').body).toBe(
      'The customer accepted the proposed time. Payment is still pending.',
    );
    expect(renderNotificationText('PROPOSAL_ACCEPTED', 'SI').body).toBe(
      'පාරිභෝගිකයා යෝජිත වේලාව පිළිගෙන ඇත. ගෙවීම තවමත් සිදු කර නැත.',
    );
  });

  it('only APPOINTMENT_CONFIRMED may claim a confirmed or booked appointment', () => {
    for (const type of ALL_TYPES) {
      if (type === 'APPOINTMENT_CONFIRMED') continue;
      for (const lang of LANGUAGES) {
        const { title, body } = NOTIFICATION_TEMPLATES[type][lang];
        const all = `${title} ${body}`.toLowerCase();
        expect(all).not.toMatch(/confirm|booked|booking|scheduled/);
        expect(all).not.toContain('තහවුරු');
      }
    }
  });

  it('contains no digits, currency or placeholders (no times, amounts or personal details)', () => {
    for (const type of ALL_TYPES) {
      for (const lang of LANGUAGES) {
        const { title, body } = NOTIFICATION_TEMPLATES[type][lang];
        const all = `${title} ${body}`;
        expect(all).not.toMatch(/[0-9]/);
        expect(all).not.toMatch(/\bRs\b|LKR|රු\./i);
        expect(all).not.toMatch(/[{}<>$%]/);
      }
    }
  });
});

describe('language resolution', () => {
  it('defaults to Sinhala', () => {
    expect(DEFAULT_NOTIFICATION_LANGUAGE).toBe('SI');
  });

  it.each(['EN', 'en', ' En ', '\tEN\n'])('%j selects English', (value) => {
    expect(resolveNotificationLanguage(value)).toBe('EN');
  });

  it.each(['SI', 'si', undefined, null, '', '  ', 'FR', 'English', 'ENG'])(
    '%j selects Sinhala',
    (value) => {
      expect(resolveNotificationLanguage(value)).toBe('SI');
    },
  );

  it('renders the recipient language and falls back to Sinhala', () => {
    expect(renderNotificationText('PROPOSAL_CREATED', 'EN').title).toBe(
      'New time proposed',
    );
    expect(renderNotificationText('PROPOSAL_CREATED', 'SI').title).toBe(
      'නව වේලාවක් යෝජනා කර ඇත',
    );
    expect(renderNotificationText('PROPOSAL_CREATED', undefined).title).toBe(
      'නව වේලාවක් යෝජනා කර ඇත',
    );
    expect(renderNotificationText('PROPOSAL_CREATED', 'xx').title).toBe(
      'නව වේලාවක් යෝජනා කර ඇත',
    );
  });

  it('returns copies so callers cannot mutate the templates', () => {
    const text = renderNotificationText('PROPOSAL_CREATED', 'EN');
    text.title = 'changed';
    expect(renderNotificationText('PROPOSAL_CREATED', 'EN').title).toBe(
      'New time proposed',
    );
  });
});
