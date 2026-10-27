import { createHmac } from 'crypto';

export type VideoParticipantRole = 'CUSTOMER' | 'ASTROLOGER';

/**
 * Deterministic, appointment-scoped Agora channel name.
 * Unpredictable without the HMAC secret; does not embed internal ids.
 */
export function buildAgoraChannelName(
  appointmentId: string,
  hmacSecret: string,
): string {
  const digest = createHmac('sha256', hmacSecret)
    .update(`agora-channel:v1:${appointmentId}`)
    .digest('hex')
    .slice(0, 32);
  return `wp_${digest}`;
}

/**
 * Stable uint32 Agora UID for a participant role on an appointment.
 * Does not use or reveal internal user / profile ids.
 */
export function buildAgoraUid(
  appointmentId: string,
  role: VideoParticipantRole,
  hmacSecret: string,
): number {
  const digest = createHmac('sha256', hmacSecret)
    .update(`agora-uid:v1:${appointmentId}:${role}`)
    .digest();
  let uid = digest.readUInt32BE(0);
  if (uid === 0) {
    uid = role === 'CUSTOMER' ? 1 : 2;
  }
  return uid >>> 0;
}
