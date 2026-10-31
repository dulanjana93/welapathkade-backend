import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ProfilePicturesController } from './profile-pictures.controller';
import { ProfilePicturesService } from './profile-pictures.service';

@Module({
  imports: [StorageModule],
  controllers: [ProfilePicturesController],
  providers: [ProfilePicturesService],
  exports: [ProfilePicturesService],
})
export class ProfilePicturesModule {}
