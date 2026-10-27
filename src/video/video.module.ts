import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { AgoraTokenService } from './agora-token.service';
import { VideoSessionService } from './video-session.service';

@Module({
  imports: [PaymentsModule],
  providers: [AgoraTokenService, VideoSessionService],
  exports: [AgoraTokenService, VideoSessionService],
})
export class VideoModule {}
