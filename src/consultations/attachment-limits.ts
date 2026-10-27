export type AttachmentLimits = {
  maxDocumentsAndImages: number;
  maxVoiceNotes: number;
  maxDocumentBytes: number;
  maxVoiceBytes: number;
  maxVoiceSeconds: number;
  abandonedAfterHours: number;
};

const DEFAULTS: AttachmentLimits = {
  maxDocumentsAndImages: 5,
  maxVoiceNotes: 1,
  maxDocumentBytes: 10 * 1024 * 1024,
  maxVoiceBytes: 10 * 1024 * 1024,
  maxVoiceSeconds: 180,
  abandonedAfterHours: 24,
};

function intFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Env can tighten the defaults. Hard ceilings match the upload pipe and DTO. */
export function attachmentLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AttachmentLimits {
  return {
    maxDocumentsAndImages: clamp(
      intFrom(env.ATTACHMENT_MAX_DOCUMENTS, DEFAULTS.maxDocumentsAndImages),
      1,
      5,
    ),
    maxVoiceNotes: clamp(
      intFrom(env.ATTACHMENT_MAX_VOICE_NOTES, DEFAULTS.maxVoiceNotes),
      0,
      1,
    ),
    maxDocumentBytes: clamp(
      intFrom(env.ATTACHMENT_MAX_DOCUMENT_BYTES, DEFAULTS.maxDocumentBytes),
      1024,
      DEFAULTS.maxDocumentBytes,
    ),
    maxVoiceBytes: clamp(
      intFrom(env.ATTACHMENT_MAX_VOICE_BYTES, DEFAULTS.maxVoiceBytes),
      1024,
      DEFAULTS.maxVoiceBytes,
    ),
    maxVoiceSeconds: clamp(
      intFrom(env.ATTACHMENT_MAX_VOICE_SECONDS, DEFAULTS.maxVoiceSeconds),
      30,
      DEFAULTS.maxVoiceSeconds,
    ),
    abandonedAfterHours: clamp(
      intFrom(env.ATTACHMENT_ABANDONED_HOURS, DEFAULTS.abandonedAfterHours),
      1,
      24 * 7,
    ),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
