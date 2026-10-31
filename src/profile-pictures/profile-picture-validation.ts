import { BadRequestException } from '@nestjs/common';

export const PROFILE_PICTURE_MAX_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, Set<string>> = {
  'image/jpeg': new Set(['jpg', 'jpeg']),
  'image/png': new Set(['png']),
  'image/webp': new Set(['webp']),
};

export function validateProfilePicture(input: {
  buffer: Buffer;
  filename: string;
}): { mimeType: string; filename: string } {
  if (!input.buffer.length) {
    throw new BadRequestException('The file is empty');
  }
  if (input.buffer.length > PROFILE_PICTURE_MAX_BYTES) {
    throw new BadRequestException('This file is larger than the upload limit');
  }
  const filename = safeProfileFilename(input.filename);
  const mimeType = detectProfileImage(input.buffer);
  if (!mimeType) {
    throw new BadRequestException(
      'This file type is not supported. Use JPEG, PNG, or WebP.',
    );
  }
  const extension = extensionOf(filename);
  if (extension && !EXTENSIONS[mimeType].has(extension)) {
    throw new BadRequestException(
      'This file type is not supported. Use JPEG, PNG, or WebP.',
    );
  }
  return { mimeType, filename };
}

function detectProfileImage(buffer: Buffer): string | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
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
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return '';
  return filename.slice(dot + 1).toLowerCase();
}

function safeProfileFilename(filename: string): string {
  const base = (filename.split(/[/\\]/).pop() ?? '').replace(/\0/g, '').trim();
  if (!base || base === '.' || base === '..') {
    throw new BadRequestException('File name is not valid');
  }
  return base.slice(0, 180);
}
