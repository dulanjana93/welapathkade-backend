import {
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
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
import { AppointmentLifecycleService } from '../payments/appointment-lifecycle.service';
import { PaymentsService } from '../payments/payments.service';
import { VideoSessionService } from '../video/video-session.service';
import { ConsultationAttachmentsService } from './consultation-attachments.service';
import { parseConsultationIdempotencyKey } from './consultation-idempotency';
import { ConsultationFollowUpService } from './consultation-follow-up.service';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { ConsultationsService } from './consultations.service';
import { CancelAppointmentDto } from './dto/appointment-cancel.dto';
import { ConfirmCheckoutDto } from './dto/checkout.dto';
import {
  CreateConsultationDto,
  ListConsultationsQueryDto,
} from './dto/consultation.dto';
import { SendFollowUpMessageDto } from './dto/follow-up.dto';
import { UpsertConsultationReviewDto } from './dto/review.dto';
import { UploadConsultationAttachmentDto } from './dto/upload-attachment.dto';
import { ConsultationReviewsService } from './consultation-reviews.service';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Catch(MulterError)
class ConsultationUploadFilter implements ExceptionFilter {
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

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@ApiTags('Consultations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('consultations')
export class ConsultationsController {
  constructor(
    private readonly consultationsService: ConsultationsService,
    private readonly attachments: ConsultationAttachmentsService,
    private readonly proposalsService: ConsultationProposalsService,
    private readonly paymentsService: PaymentsService,
    private readonly lifecycle: AppointmentLifecycleService,
    private readonly videoSessions: VideoSessionService,
    private readonly followUp: ConsultationFollowUpService,
    private readonly reviews: ConsultationReviewsService,
  ) {}

  @Post()
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Create a consultation request (preferred time only — no reservation). Optional Idempotency-Key replays the same submission.',
  })
  create(
    @CurrentUser() user: User,
    @Body() dto: CreateConsultationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.consultationsService.create(
      user,
      dto,
      parseConsultationIdempotencyKey(idempotencyKey),
    );
  }

  @Post('attachments')
  @Roles(UserRole.PUBLIC)
  @UseFilters(ConsultationUploadFilter)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'kind'],
      properties: {
        kind: { type: 'string', enum: ['DOCUMENT', 'IMAGE', 'VOICE_NOTE'] },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({
    summary:
      'Upload a private document, photo, or voice note before creating a request',
  })
  uploadAttachment(
    @CurrentUser() user: User,
    @Body() dto: UploadConsultationAttachmentDto,
    @UploadedFile()
    file?: {
      buffer: Buffer;
      originalname: string;
      mimetype?: string;
      size: number;
    },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Choose a file to upload');
    }
    return this.attachments.upload(user, dto.kind, file);
  }

  @Get('me')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({ summary: 'List the current customer consultation requests' })
  listMine(
    @CurrentUser() user: User,
    @Query() query: ListConsultationsQueryDto,
  ) {
    return this.consultationsService.listForCustomer(user, query.status);
  }

  @Get(':consultationId/proposals')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'List proposal history for own consultation (newest first). Not a booking.',
  })
  listProposals(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.proposalsService.listForCustomer(user, consultationId);
  }

  @Post(':consultationId/proposals/:proposalId/accept')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Accept a PENDING proposal (scheduling only — no payment/reservation)',
  })
  acceptProposal(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Param('proposalId') proposalId: string,
  ) {
    return this.proposalsService.acceptForCustomer(
      user,
      consultationId,
      proposalId,
    );
  }

  @Post(':consultationId/proposals/:proposalId/reject')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Reject a PENDING proposal (astrologer may propose another time afterward)',
  })
  rejectProposal(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Param('proposalId') proposalId: string,
  ) {
    return this.proposalsService.rejectForCustomer(
      user,
      consultationId,
      proposalId,
    );
  }

  @Post(':consultationId/proposals/:proposalId/checkout')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Confirm & Pay: reserve the accepted proposal slot and start mock checkout. Amount is server-side only.',
  })
  checkout(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Param('proposalId') proposalId: string,
    @Body() _dto?: ConfirmCheckoutDto,
  ) {
    return this.paymentsService.checkout(user, consultationId, proposalId);
  }

  @Get(':consultationId/appointment')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary: 'Get appointment + payment status for own consultation',
  })
  getAppointment(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.paymentsService.getForCustomer(user, consultationId);
  }

  @Post(':consultationId/appointment/sync')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Re-verify payment with the gateway and return current appointment status',
  })
  syncAppointment(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.paymentsService.syncForCustomer(user, consultationId);
  }

  @Post(':consultationId/appointment/cancel')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Cancel own CONFIRMED appointment at any time BEFORE its scheduled start (409 afterwards). Records a 100% refund obligation (no refund is issued here).',
  })
  cancelAppointment(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Body() dto: CancelAppointmentDto,
  ) {
    return this.lifecycle.cancelByCustomer(user, consultationId, dto.reason);
  }

  @Post(':consultationId/appointment/video-session')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Obtain Agora RTC credentials for own eligible appointment (join window / in-progress). Does not complete the consultation or record attendance.',
  })
  issueVideoSession(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.videoSessions.issueCredentialsForConsultation(
      user,
      consultationId,
    );
  }

  @Get(':consultationId/messages')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'List post-session follow-up messages for a completed consultation (oldest first)',
  })
  listMessages(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.followUp.listForCustomer(user, consultationId);
  }

  @Post(':consultationId/messages')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Send a plain-text follow-up message (max 5 customer messages within 48h of completion)',
  })
  sendMessage(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Body() dto: SendFollowUpMessageDto,
  ) {
    return this.followUp.sendForCustomer(user, consultationId, dto.body);
  }

  @Get(':consultationId/book-again')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Check Book Again eligibility and return current astrologer/service prefills (never reuses old times)',
  })
  bookAgain(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.followUp.bookAgainForCustomer(user, consultationId);
  }

  @Get(':consultationId/review')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary: 'Get the authenticated customer review for a consultation (or null)',
  })
  getReview(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.reviews.getOwnForCustomer(user, consultationId);
  }

  @Post(':consultationId/review')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary:
      'Submit a 1–5 star review for an eligible completed consultation (one per consultation)',
  })
  createReview(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Body() dto: UpsertConsultationReviewDto,
  ) {
    return this.reviews.createForCustomer(
      user,
      consultationId,
      dto.rating,
      dto.body,
    );
  }

  @Patch(':consultationId/review')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary: 'Update the authenticated customer review while still eligible',
  })
  updateReview(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Body() dto: UpsertConsultationReviewDto,
  ) {
    return this.reviews.updateForCustomer(
      user,
      consultationId,
      dto.rating,
      dto.body,
    );
  }

  @Get(':consultationId/attachments/:attachmentId/content')
  @Roles(UserRole.PUBLIC, UserRole.ASTROLOGER)
  @ApiOperation({
    summary:
      'Stream an attachment for the owning customer or the assigned astrologer. Pending requests are included. No public URL is issued.',
  })
  async content(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const file = await this.attachments.openContent(
      user,
      consultationId,
      attachmentId,
    );
    return new StreamableFile(file.body, {
      type: file.mimeType,
      disposition: contentDisposition(file.filename),
    });
  }

  @Get(':id')
  @Roles(UserRole.PUBLIC, UserRole.ASTROLOGER)
  @ApiOperation({
    summary:
      'Get consultation detail including proposal summary (customer owner or assigned astrologer)',
  })
  getOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.consultationsService.getByIdForActor(user, id);
  }

  @Post(':id/cancel')
  @Roles(UserRole.PUBLIC)
  @ApiOperation({ summary: 'Cancel own PENDING consultation request' })
  cancel(@CurrentUser() user: User, @Param('id') id: string) {
    return this.consultationsService.cancel(user, id);
  }
}
