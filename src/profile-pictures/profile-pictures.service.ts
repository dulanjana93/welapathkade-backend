import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AstrologerProfileStatus,
  AstrologerServiceStatus,
  FileStatus,
  Prisma,
  ServiceStatus,
  UserRole,
  UserStatus,
  type User,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage';
import { validateProfilePicture } from './profile-picture-validation';

export type ProfilePictureContent = {
  body: Buffer;
  mimeType: string;
};

type PictureClaim = {
  previousFileId: string | null;
};

/**
 * Private profile pictures for the signed-in customer or astrologer.
 * The object is written before the database pointer moves. The previous
 * object is deleted only after that pointer no longer references it.
 */
@Injectable()
export class ProfilePicturesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async upload(
    user: User,
    file: { buffer: Buffer; originalname: string; mimetype?: string },
  ): Promise<{ hasProfilePicture: true }> {
    this.assertOwnerRole(user);
    const checked = validateProfilePicture({
      buffer: file.buffer,
      filename: file.originalname,
    });
    const declared = (file.mimetype ?? '').split(';')[0].trim().toLowerCase();
    if (
      declared &&
      declared !== 'application/octet-stream' &&
      declared !== checked.mimeType
    ) {
      throw new BadRequestException('The file content does not match its type');
    }
    const id = randomUUID();
    const objectKey = `profiles/${user.id}/${id}`;
    try {
      await this.storage.put(objectKey, file.buffer, checked.mimeType);
    } catch {
      throw new BadRequestException('Profile picture could not be stored');
    }
    let claim: PictureClaim;
    try {
      claim = await this.prisma.$transaction((tx) =>
        this.claimPicture(tx, user.id, {
          id,
          objectKey,
          filename: checked.filename,
          mimeType: checked.mimeType,
          sizeBytes: file.buffer.length,
          checksum: createHash('sha256').update(file.buffer).digest('hex'),
        }),
      );
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      if (error instanceof HttpException) throw error;
      throw new BadRequestException('Profile picture could not be stored');
    }
    if (claim.previousFileId) {
      await this.releaseIfUnreferenced(claim.previousFileId).catch(
        () => undefined,
      );
    }
    return { hasProfilePicture: true };
  }

  async remove(user: User): Promise<{ hasProfilePicture: false }> {
    this.assertOwnerRole(user);
    const owner = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { profilePictureFileId: true },
    });
    const fileId = owner?.profilePictureFileId;
    if (!fileId) {
      throw new NotFoundException('Profile picture not found');
    }
    const cleared = await this.prisma.user.updateMany({
      where: { id: user.id, profilePictureFileId: fileId },
      data: { profilePictureFileId: null },
    });
    if (cleared.count !== 1) {
      throw new NotFoundException('Profile picture not found');
    }
    try {
      await this.releaseIfUnreferenced(fileId);
    } catch {
      await this.prisma.user.updateMany({
        where: { id: user.id, profilePictureFileId: null },
        data: { profilePictureFileId: fileId },
      });
      throw new BadRequestException('Profile picture could not be removed');
    }
    return { hasProfilePicture: false };
  }

  async openOwn(user: User): Promise<ProfilePictureContent> {
    this.assertOwnerRole(user);
    const owner = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: { profilePicture: true },
    });
    const picture = owner?.profilePicture;
    if (!picture || picture.status !== FileStatus.AVAILABLE) {
      throw new NotFoundException('Profile picture not found');
    }
    return this.readStored(picture.objectKey, picture.mimeType);
  }

  /**
   * Discoverable astrologer pictures are part of the public profile.
   * The bucket stays private; the API streams the bytes.
   * Customer pictures are never served here.
   */
  async openDiscoverableAstrologer(
    profileId: string,
  ): Promise<ProfilePictureContent> {
    const profile = await this.prisma.astrologerProfile.findFirst({
      where: {
        id: profileId,
        status: AstrologerProfileStatus.ACTIVE,
        user: {
          role: UserRole.ASTROLOGER,
          status: UserStatus.ACTIVE,
          profilePicture: { status: FileStatus.AVAILABLE },
        },
        services: {
          some: {
            status: AstrologerServiceStatus.ACTIVE,
            service: { status: ServiceStatus.ACTIVE },
          },
        },
      },
      select: {
        user: {
          select: {
            profilePicture: {
              select: { objectKey: true, mimeType: true, status: true },
            },
          },
        },
      },
    });
    const picture = profile?.user.profilePicture;
    if (!picture || picture.status !== FileStatus.AVAILABLE) {
      throw new NotFoundException('Profile picture not found');
    }
    return this.readStored(picture.objectKey, picture.mimeType);
  }

  private assertOwnerRole(user: User): void {
    if (user.role !== UserRole.PUBLIC && user.role !== UserRole.ASTROLOGER) {
      throw new ForbiddenException('Profile picture could not be changed');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Account is not active');
    }
  }

  private async claimPicture(
    tx: Prisma.TransactionClient,
    userId: string,
    file: {
      id: string;
      objectKey: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      checksum: string;
    },
  ): Promise<PictureClaim> {
    const owner = await tx.user.findUnique({
      where: { id: userId },
      select: { profilePictureFileId: true },
    });
    if (!owner) {
      throw new NotFoundException('Profile picture not found');
    }
    const previousFileId = owner.profilePictureFileId;
    await tx.file.create({
      data: {
        id: file.id,
        provider: this.storage.provider,
        bucket: this.storage.bucket,
        objectKey: file.objectKey,
        originalFilename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        checksum: file.checksum,
        uploadedByUserId: userId,
        status: FileStatus.AVAILABLE,
      },
    });
    const claimed = await tx.user.updateMany({
      where: { id: userId, profilePictureFileId: previousFileId },
      data: { profilePictureFileId: file.id },
    });
    if (claimed.count !== 1) {
      await tx.file.delete({ where: { id: file.id } });
      throw new BadRequestException('Profile picture could not be stored');
    }
    return { previousFileId };
  }

  private async releaseIfUnreferenced(fileId: string): Promise<void> {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        consultationFiles: { select: { id: true }, take: 1 },
        profilePictureOwner: { select: { id: true } },
      },
    });
    if (!file || file.status !== FileStatus.AVAILABLE) return;
    if (file.consultationFiles.length > 0 || file.profilePictureOwner) return;
    await this.storage.delete(file.objectKey);
    await this.prisma.file.update({
      where: { id: fileId },
      data: { status: FileStatus.DELETED },
    });
  }

  private async readStored(
    objectKey: string,
    mimeType: string,
  ): Promise<ProfilePictureContent> {
    try {
      const body = await this.storage.get(objectKey);
      return { body, mimeType };
    } catch {
      throw new NotFoundException('Profile picture not found');
    }
  }
}
