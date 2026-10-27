import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import {
  buildAgoraChannelName,
  buildAgoraUid,
  type VideoParticipantRole,
} from './agora-identity';

export type AgoraRtcCredentials = {
  provider: 'agora';
  appId: string;
  channelName: string;
  uid: number;
  token: string;
  tokenExpiresAt: string;
  privilegeExpiresAt: string;
  participantRole: VideoParticipantRole;
};

type AgoraConfig = {
  appId: string;
  appCertificate: string;
};

@Injectable()
export class AgoraTokenService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Build AccessToken2 RTC credentials for one participant.
   * Never returns or logs the App Certificate.
   */
  issueRtcCredentials(params: {
    appointmentId: string;
    participantRole: VideoParticipantRole;
    ttlSeconds: number;
    now?: Date;
  }): AgoraRtcCredentials {
    const { appId, appCertificate } = this.requireConfig();
    const now = params.now ?? new Date();
    const channelName = buildAgoraChannelName(
      params.appointmentId,
      appCertificate,
    );
    const uid = buildAgoraUid(
      params.appointmentId,
      params.participantRole,
      appCertificate,
    );
    const ttl = Math.max(1, Math.floor(params.ttlSeconds));
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      ttl,
      ttl,
    );
    if (!token) {
      throw new ServiceUnavailableException(
        'Agora token generation failed; check AGORA_APP_ID / AGORA_APP_CERTIFICATE',
      );
    }
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    return {
      provider: 'agora',
      appId,
      channelName,
      uid,
      token,
      tokenExpiresAt: expiresAt,
      privilegeExpiresAt: expiresAt,
      participantRole: params.participantRole,
    };
  }

  /** Same channel for both roles; different UIDs (test / consistency helper). */
  describeChannelBinding(appointmentId: string): {
    channelName: string;
    customerUid: number;
    astrologerUid: number;
  } {
    const { appCertificate } = this.requireConfig();
    const channelName = buildAgoraChannelName(appointmentId, appCertificate);
    const customerUid = buildAgoraUid(
      appointmentId,
      'CUSTOMER',
      appCertificate,
    );
    const astrologerUid = buildAgoraUid(
      appointmentId,
      'ASTROLOGER',
      appCertificate,
    );
    return { channelName, customerUid, astrologerUid };
  }

  isConfigured(): boolean {
    try {
      this.requireConfig();
      return true;
    } catch {
      return false;
    }
  }

  private requireConfig(): AgoraConfig {
    const appId = this.config.get<string>('app.agoraAppId')?.trim();
    const appCertificate = this.config
      .get<string>('app.agoraAppCertificate')
      ?.trim();
    if (!appId || !appCertificate) {
      throw new ServiceUnavailableException(
        'Agora video credentials are not configured on this server',
      );
    }
    return { appId, appCertificate };
  }
}
