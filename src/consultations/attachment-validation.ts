import { BadRequestException } from '@nestjs/common';
import { ConsultationFileType } from '@prisma/client';
import { AttachmentLimits } from './attachment-limits';

export type UploadKind = 'DOCUMENT' | 'IMAGE' | 'VOICE_NOTE';

const DOCUMENT_EXTENSIONS = new Set(['pdf']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const VOICE_EXTENSIONS = new Set(['m4a']);

export type DetectedFile = {
  mimeType: string;
  kind: UploadKind;
};

export function extensionOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function safeOriginalFilename(filename: string): string {
  const base = (filename.split(/[/\\]/).pop() ?? '').replace(/\0/g, '').trim();
  if (!base || base === '.' || base === '..') {
    throw new BadRequestException('File name is not valid');
  }
  return base.slice(0, 180);
}

export function detectAttachment(buffer: Buffer): DetectedFile | null {
  if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  ) {
    return { mimeType: 'application/pdf', kind: 'DOCUMENT' };
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mimeType: 'image/jpeg', kind: 'IMAGE' };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', kind: 'IMAGE' };
  }
  if (looksLikeM4a(buffer)) {
    return { mimeType: 'audio/mp4', kind: 'VOICE_NOTE' };
  }
  return null;
}

export function readMvhdDurationSeconds(buffer: Buffer): number | null {
  const marker = buffer.indexOf('mvhd');
  if (marker < 0 || marker + 24 > buffer.length) return null;
  const version = buffer[marker + 4];
  if (version === 0) {
    if (marker + 24 > buffer.length) return null;
    const timescale = buffer.readUInt32BE(marker + 16);
    const duration = buffer.readUInt32BE(marker + 20);
    if (!timescale) return null;
    return duration / timescale;
  }
  if (version === 1) {
    if (marker + 36 > buffer.length) return null;
    const timescale = buffer.readUInt32BE(marker + 24);
    const duration = buffer.readBigUInt64BE(marker + 28);
    if (!timescale) return null;
    return Number(duration) / timescale;
  }
  return null;
}

/**
 * Checks the declared kind, extension, and signature. The stored MIME type is
 * the one derived from the bytes, never a client-supplied type that disagrees.
 */
export function validateUpload(input: {
  buffer: Buffer;
  filename: string;
  kind: UploadKind;
  declaredMime?: string;
  limits: AttachmentLimits;
}): { mimeType: string; filename: string; durationSeconds?: number } {
  if (!input.buffer.length) {
    throw new BadRequestException('The file is empty');
  }
  const filename = safeOriginalFilename(input.filename);
  const extension = extensionOf(filename);
  const detected = detectAttachment(input.buffer);
  if (!detected || detected.kind !== input.kind) {
    throw new BadRequestException(
      'This file type is not supported. Use PDF, JPEG, PNG, or M4A.',
    );
  }
  const allowed =
    input.kind === 'DOCUMENT'
      ? DOCUMENT_EXTENSIONS
      : input.kind === 'IMAGE'
        ? IMAGE_EXTENSIONS
        : VOICE_EXTENSIONS;
  if (!allowed.has(extension)) {
    throw new BadRequestException(
      'This file type is not supported. Use PDF, JPEG, PNG, or M4A.',
    );
  }
  const declared = (input.declaredMime ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const generic =
    declared === '' ||
    declared === 'application/octet-stream' ||
    declared === 'audio/m4a' ||
    declared === 'audio/x-m4a' ||
    declared === 'audio/aac';
  if (!generic && declared !== detected.mimeType) {
    throw new BadRequestException('The file content does not match its type');
  }
  const maxBytes =
    input.kind === 'VOICE_NOTE'
      ? input.limits.maxVoiceBytes
      : input.limits.maxDocumentBytes;
  if (input.buffer.length > maxBytes) {
    throw new BadRequestException('This file is larger than the upload limit');
  }
  if (input.kind === 'VOICE_NOTE') {
    const duration = readMvhdDurationSeconds(input.buffer);
    if (duration === null) {
      throw new BadRequestException(
        'Voice note duration could not be verified',
      );
    }
    if (duration > input.limits.maxVoiceSeconds) {
      throw new BadRequestException('Voice notes can be up to 3 minutes');
    }
    return { mimeType: detected.mimeType, filename, durationSeconds: duration };
  }
  return { mimeType: detected.mimeType, filename };
}

const DOCUMENT_MIMES = new Set(['application/pdf']);
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
const VOICE_MIMES = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
]);

export function assertAttachmentsLinkable(
  ownedFiles: Array<{ id: string; mimeType: string; linked: boolean }>,
  requested: Array<{ fileId: string; type: ConsultationFileType }>,
  limits: AttachmentLimits,
): void {
  const ids = requested.map((item) => item.fileId);
  if (new Set(ids).size !== ids.length) {
    throw new BadRequestException('Duplicate file attachments');
  }
  if (ownedFiles.length !== ids.length) {
    throw new BadRequestException(
      'One or more files are missing or not owned by you',
    );
  }
  const byId = new Map(ownedFiles.map((file) => [file.id, file]));
  let documents = 0;
  let voices = 0;
  for (const item of requested) {
    const file = byId.get(item.fileId);
    if (!file) {
      throw new BadRequestException(
        'One or more files are missing or not owned by you',
      );
    }
    if (file.linked) {
      throw new BadRequestException(
        'One or more files are already attached to a request',
      );
    }
    if (!mimeMatchesType(file.mimeType, item.type)) {
      throw new BadRequestException('Attachment type does not match the file');
    }
    if (item.type === ConsultationFileType.VOICE_NOTE) voices += 1;
    else documents += 1;
  }
  if (documents > limits.maxDocumentsAndImages) {
    throw new BadRequestException('Too many documents or photos');
  }
  if (voices > limits.maxVoiceNotes) {
    throw new BadRequestException('Too many voice notes');
  }
}

function mimeMatchesType(
  mimeType: string,
  type: ConsultationFileType,
): boolean {
  const mime = mimeType.toLowerCase();
  if (type === ConsultationFileType.VOICE_NOTE) return VOICE_MIMES.has(mime);
  if (type === ConsultationFileType.IMAGE) return IMAGE_MIMES.has(mime);
  if (type === ConsultationFileType.DOCUMENT) return DOCUMENT_MIMES.has(mime);
  return DOCUMENT_MIMES.has(mime) || IMAGE_MIMES.has(mime);
}

function looksLikeM4a(buffer: Buffer): boolean {
  const head = buffer
    .subarray(0, Math.min(buffer.length, 64))
    .toString('ascii');
  if (!head.includes('ftyp')) return false;
  return (
    head.includes('M4A ') ||
    head.includes('M4A') ||
    head.includes('mp42') ||
    head.includes('isom') ||
    head.includes('mp41')
  );
}
