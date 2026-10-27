import {
  ConflictException,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppointmentStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AstrologerConsultationsController } from '../consultations/astrologer-consultations.controller';
import { ConsultationFollowUpService } from '../consultations/consultation-follow-up.service';
import { ConsultationProposalsService } from '../consultations/consultation-proposals.service';
import { ConsultationReviewsService } from '../consultations/consultation-reviews.service';
import { ConsultationsController } from '../consultations/consultations.controller';
import { ConsultationsService } from '../consultations/consultations.service';
import { AppointmentLifecycleService } from '../payments/appointment-lifecycle.service';
import { PaymentsService } from '../payments/payments.service';
import { VideoSessionService } from './video-session.service';

describe('video-session controllers (integration)', () => {
  let app: INestApplication<App>;
  const issue = jest.fn();

  const customer = { id: 'user-customer', role: UserRole.PUBLIC };
  const astrologer = { id: 'user-astro', role: UserRole.ASTROLOGER };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ConsultationsController, AstrologerConsultationsController],
      providers: [
        {
          provide: VideoSessionService,
          useValue: { issueCredentialsForConsultation: issue },
        },
        { provide: ConsultationsService, useValue: {} },
        { provide: ConsultationProposalsService, useValue: {} },
        { provide: ConsultationFollowUpService, useValue: {} },
        { provide: ConsultationReviewsService, useValue: {} },
        { provide: PaymentsService, useValue: {} },
        { provide: AppointmentLifecycleService, useValue: {} },
        RolesGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{
            user?: unknown;
            headers: { authorization?: string };
          }>();
          const auth = req.headers.authorization ?? '';
          if (auth.includes('astro')) {
            req.user = astrologer;
            return true;
          }
          if (auth.includes('customer')) {
            req.user = customer;
            return true;
          }
          throw new UnauthorizedException();
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    issue.mockReset();
    issue.mockResolvedValue({
      provider: 'agora',
      appId: 'a1b2c3d4e5f64789a0b1c2d3e4f50617',
      channelName: 'wp_abc',
      uid: 42,
      token: 'tok',
      tokenExpiresAt: '2026-10-10T12:05:00.000Z',
      privilegeExpiresAt: '2026-10-10T12:05:00.000Z',
      participantRole: 'CUSTOMER',
    });
  });

  it('customer route calls the video session service', async () => {
    const res = await request(app.getHttpServer())
      .post('/consultations/c1/appointment/video-session')
      .set('Authorization', 'Bearer customer')
      .expect(200);

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-customer' }),
      'c1',
    );
    expect(res.body.appId).toBeTruthy();
    expect(res.body).not.toHaveProperty('appCertificate');
    expect(JSON.stringify(res.body)).not.toMatch(/certificate/i);
  });

  it('astrologer route calls the video session service', async () => {
    issue.mockResolvedValue({
      provider: 'agora',
      appId: 'a1b2c3d4e5f64789a0b1c2d3e4f50617',
      channelName: 'wp_abc',
      uid: 99,
      token: 'tok',
      tokenExpiresAt: '2026-10-10T12:05:00.000Z',
      privilegeExpiresAt: '2026-10-10T12:05:00.000Z',
      participantRole: 'ASTROLOGER',
    });
    await request(app.getHttpServer())
      .post('/astrologers/me/consultations/c1/appointment/video-session')
      .set('Authorization', 'Bearer astro')
      .expect(200);
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-astro' }),
      'c1',
    );
  });

  it('rejects unauthenticated callers', async () => {
    await request(app.getHttpServer())
      .post('/consultations/c1/appointment/video-session')
      .expect(401);
  });

  it('surfaces ineligible appointment conflicts from the service', async () => {
    issue.mockRejectedValue(
      new ConflictException(
        `Video session is not available for appointment status ${AppointmentStatus.COMPLETED}`,
      ),
    );
    await request(app.getHttpServer())
      .post('/consultations/c1/appointment/video-session')
      .set('Authorization', 'Bearer customer')
      .expect(409);
  });
});
