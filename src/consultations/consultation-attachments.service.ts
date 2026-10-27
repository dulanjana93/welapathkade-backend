import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FileStatus, Prisma, User, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { attachmentLimitsFromEnv } from './attachment-limits';
import { UploadKind, validateUpload } from './attachment-validation';

export type UploadedAttachment = {
  id: string;
  kind: UploadKind;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: FileStatus;
};

export type AttachmentContent = {
  body: Buffer;
  mimeType: string;
  filename: string;
};

/**
 * Uploads are private and owner-bound before a consultation exists.
 * Linking happens later, inside the consultation create transaction.
 * Object storage and MySQL are not one transaction: the object is written
 * first, and the row is removed from storage again if the row insert fails.
 * A row that never gets linked is deleted by purgeAbandonedUploads.
 */
@Injectable()
export class ConsultationAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async upload(
    user: User,
    kind: UploadKind,
    file: { buffer: Buffer; originalname: string; mimetype?: string },
  ): Promise<UploadedAttachment> {
    if (user.role !== UserRole.PUBLIC) {
      throw new NotFoundException('Attachment not found');
    }
    const limits = attachmentLimitsFromEnv();
    const checked = validateUpload({
      buffer: file.buffer,
      filename: file.originalname,
      kind,
      declaredMime: file.mimetype,
      limits,
    });
    const id = randomUUID();
    const objectKey = `consultations/unlinked/${user.id}/${id}`;
    try {
      await this.storage.put(objectKey, file.buffer, checked.mimeType);
    } catch {
      throw new BadRequestException('Attachment could not be stored');
    }
    try {
      const row = await this.prisma.file.create({
        data: {
          id,
          provider: this.storage.provider,
          bucket: this.storage.bucket,
          objectKey,
          originalFilename: checked.filename,
          mimeType: checked.mimeType,
          sizeBytes: file.buffer.length,
          checksum: createHash('sha256').update(file.buffer).digest('hex'),
          uploadedByUserId: user.id,
          status: FileStatus.AVAILABLE,
        },
      });
      return {
        id: row.id,
        kind,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        status: row.status,
      };
    } catch {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw new BadRequestException('Attachment could not be stored');
    }
  }

  /**
   * Owning customer, or the astrologer assigned to the request (including
   * while it is still pending). Everyone else gets the same not-found.
   */
  async openContent(
    user: User,
    consultationId: string,
    attachmentId: string,
  ): Promise<AttachmentContent> {
    const row = await this.prisma.consultationFile.findFirst({
      where: { id: attachmentId, consultationId },
      include: {
        file: true,
        consultation: {
          select: {
            customerId: true,
            status: true,
            astrologer: { select: { userId: true } },
          },
        },
      },
    });
    const allowed =
      !!row &&
      row.file.status === FileStatus.AVAILABLE &&
      ((user.role === UserRole.PUBLIC &&
        row.consultation.customerId === user.id) ||
        (user.role === UserRole.ASTROLOGER &&
          row.consultation.astrologer.userId === user.id));
    if (!row || !allowed) {
      throw new NotFoundException('Attachment not found');
    }
    let body: Buffer;
    try {
      body = await this.storage.get(row.file.objectKey);
    } catch {
      throw new NotFoundException('Attachment not found');
    }
    return {
      body,
      mimeType: row.file.mimeType,
      filename: row.file.originalFilename,
    };
  }

  /**
   * Deletes unlinked uploads older than the configured window.
   * Files already linked to a request are kept through decline, cancel,
   * and expiry. There is no separate long-term retention policy.
   */
  async purgeAbandonedUploads(now: Date = new Date()): Promise<number> {
    const limits = attachmentLimitsFromEnv();
    const cutoff = new Date(
      now.getTime() - limits.abandonedAfterHours * 60 * 60 * 1000,
    );
    const stale = await this.prisma.file.findMany({
      where: {
        status: FileStatus.AVAILABLE,
        createdAt: { lt: cutoff },
        consultationFiles: { none: {} },
      },
      select: { id: true, objectKey: true },
      take: 50,
    });
    let removed = 0;
    for (const file of stale) {
      await this.storage.delete(file.objectKey);
      await this.prisma.file.update({
        where: { id: file.id },
        data: { status: FileStatus.DELETED },
      });
      removed += 1;
    }
    return removed;
  }
}

export function isAttachmentUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
