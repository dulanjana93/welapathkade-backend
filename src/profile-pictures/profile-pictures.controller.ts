import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  Header,
  Post,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import { MulterError } from 'multer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PROFILE_PICTURE_MAX_BYTES } from './profile-picture-validation';
import { ProfilePicturesService } from './profile-pictures.service';

@Catch(MulterError)
class ProfilePictureUploadFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const message =
      exception.code === 'LIMIT_FILE_SIZE'
        ? 'This file is larger than the upload limit'
        : 'Upload could not be read';
    response.status(400).json({ message });
  }
}

@ApiTags('Profile picture')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PUBLIC, UserRole.ASTROLOGER)
@Controller('me/profile-picture')
export class ProfilePicturesController {
  constructor(private readonly pictures: ProfilePicturesService) {}

  @Post()
  @UseFilters(ProfilePictureUploadFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: PROFILE_PICTURE_MAX_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary:
      'Replace the signed-in user profile picture. The image stays private.',
  })
  upload(
    @CurrentUser() user: User,
    @UploadedFile()
    file?: { buffer: Buffer; originalname: string; mimetype?: string },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Choose a file to upload');
    }
    return this.pictures.upload(user, file);
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Stream the signed-in user profile picture. No public URL.',
  })
  async content(@CurrentUser() user: User) {
    const file = await this.pictures.openOwn(user);
    return new StreamableFile(file.body, {
      type: file.mimeType,
      disposition: 'inline; filename="profile"',
    });
  }

  @Delete()
  @ApiOperation({ summary: 'Remove the signed-in user profile picture' })
  remove(@CurrentUser() user: User) {
    return this.pictures.remove(user);
  }
}
