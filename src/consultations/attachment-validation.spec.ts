import { ConsultationFileType } from '@prisma/client';
import { attachmentLimitsFromEnv } from './attachment-limits';
import {
  assertAttachmentsLinkable,
  detectAttachment,
  readMvhdDurationSeconds,
  validateUpload,
} from './attachment-validation';

const limits = attachmentLimitsFromEnv({});

function png(bytes = 32): Buffer {
  const body = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  return body;
}

function jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}

function pdf(): Buffer {
  return Buffer.from('%PDF-1.4\n');
}

function m4a(durationSeconds: number): Buffer {
  const ftypPayload = Buffer.concat([
    Buffer.from('ftyp'),
    Buffer.from('M4A '),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('M4A '),
  ]);
  const ftypSize = Buffer.alloc(4);
  ftypSize.writeUInt32BE(ftypPayload.length + 4);
  const mvhd = Buffer.alloc(28);
  mvhd.write('mvhd', 0, 'ascii');
  mvhd.writeUInt32BE(1000, 16);
  mvhd.writeUInt32BE(durationSeconds * 1000, 20);
  return Buffer.concat([ftypSize, ftypPayload, mvhd]);
}

describe('attachment signatures', () => {
  it('accepts pdf, jpeg, png, and m4a signatures', () => {
    expect(detectAttachment(pdf())?.mimeType).toBe('application/pdf');
    expect(detectAttachment(jpeg())?.mimeType).toBe('image/jpeg');
    expect(detectAttachment(png())?.mimeType).toBe('image/png');
    expect(detectAttachment(m4a(2))?.mimeType).toBe('audio/mp4');
    expect(detectAttachment(Buffer.from('not a file'))).toBeNull();
  });

  it('rejects a mismatched extension, mime, and an oversized file', () => {
    expect(() =>
      validateUpload({
        buffer: png(),
        filename: 'chart.pdf',
        kind: 'IMAGE',
        limits,
      }),
    ).toThrow(/not supported/);
    expect(() =>
      validateUpload({
        buffer: png(),
        filename: 'chart.png',
        kind: 'IMAGE',
        declaredMime: 'application/pdf',
        limits,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      validateUpload({
        buffer: png(limits.maxDocumentBytes + 1),
        filename: 'chart.png',
        kind: 'IMAGE',
        limits,
      }),
    ).toThrow(/larger than/);
  });

  it('rejects a voice note that is too long or has no duration', () => {
    expect(readMvhdDurationSeconds(m4a(30))).toBe(30);
    expect(() =>
      validateUpload({
        buffer: m4a(181),
        filename: 'note.m4a',
        kind: 'VOICE_NOTE',
        limits,
      }),
    ).toThrow(/3 minutes/);
    const noDuration = m4a(2);
    noDuration.fill(
      0,
      noDuration.indexOf('mvhd'),
      noDuration.indexOf('mvhd') + 4,
    );
    expect(() =>
      validateUpload({
        buffer: noDuration,
        filename: 'note.m4a',
        kind: 'VOICE_NOTE',
        limits,
      }),
    ).toThrow(/duration could not be verified/);
  });
});

describe('linking attachments', () => {
  const owned = (id: string, mimeType: string, linked = false) => ({
    id,
    mimeType,
    linked,
  });

  it('rejects another owner, reuse, duplicates, and count limits', () => {
    expect(() =>
      assertAttachmentsLinkable(
        [],
        [{ fileId: 'other', type: ConsultationFileType.IMAGE }],
        limits,
      ),
    ).toThrow(/not owned/);
    expect(() =>
      assertAttachmentsLinkable(
        [owned('a', 'image/png', true)],
        [{ fileId: 'a', type: ConsultationFileType.IMAGE }],
        limits,
      ),
    ).toThrow(/already attached/);
    expect(() =>
      assertAttachmentsLinkable(
        [owned('a', 'image/png')],
        [
          { fileId: 'a', type: ConsultationFileType.IMAGE },
          { fileId: 'a', type: ConsultationFileType.IMAGE },
        ],
        limits,
      ),
    ).toThrow(/Duplicate/);
    expect(() =>
      assertAttachmentsLinkable(
        Array.from({ length: 6 }, (_, i) => owned(String(i), 'image/png')),
        Array.from({ length: 6 }, (_, i) => ({
          fileId: String(i),
          type: ConsultationFileType.IMAGE,
        })),
        limits,
      ),
    ).toThrow(/Too many documents/);
    expect(() =>
      assertAttachmentsLinkable(
        [owned('v1', 'audio/mp4'), owned('v2', 'audio/mp4')],
        [
          { fileId: 'v1', type: ConsultationFileType.VOICE_NOTE },
          { fileId: 'v2', type: ConsultationFileType.VOICE_NOTE },
        ],
        limits,
      ),
    ).toThrow(/Too many voice/);
  });

  it('allows an owned unused image and a legacy kundali', () => {
    expect(() =>
      assertAttachmentsLinkable(
        [owned('a', 'image/png'), owned('b', 'application/pdf')],
        [
          { fileId: 'a', type: ConsultationFileType.IMAGE },
          { fileId: 'b', type: ConsultationFileType.KUNDALI },
        ],
        limits,
      ),
    ).not.toThrow();
  });

  it('rejects a type that does not match the stored mime', () => {
    expect(() =>
      assertAttachmentsLinkable(
        [owned('a', 'application/pdf')],
        [{ fileId: 'a', type: ConsultationFileType.VOICE_NOTE }],
        limits,
      ),
    ).toThrow(/does not match/);
  });
});
