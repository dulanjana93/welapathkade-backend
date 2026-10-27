import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UploadConsultationAttachmentDto {
  @ApiProperty({ enum: ['DOCUMENT', 'IMAGE', 'VOICE_NOTE'] })
  @IsIn(['DOCUMENT', 'IMAGE', 'VOICE_NOTE'])
  kind!: 'DOCUMENT' | 'IMAGE' | 'VOICE_NOTE';
}
