import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AppointmentLifecycleService } from '../payments/appointment-lifecycle.service';
import { VideoSessionService } from '../video/video-session.service';
import { ConsultationFollowUpService } from './consultation-follow-up.service';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { ConsultationsService } from './consultations.service';
import { CancelAppointmentDto } from './dto/appointment-cancel.dto';
import {
  DeclineConsultationDto,
  ListConsultationsQueryDto,
} from './dto/consultation.dto';
import {
  SendFollowUpMessageDto,
  UpsertAstrologerSummaryDto,
} from './dto/follow-up.dto';
import { CreateConsultationProposalDto } from './dto/proposal.dto';

@ApiTags('Astrologer Consultations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ASTROLOGER)
@Controller('astrologers/me/consultations')
export class AstrologerConsultationsController {
  constructor(
    private readonly consultationsService: ConsultationsService,
    private readonly proposalsService: ConsultationProposalsService,
    private readonly lifecycle: AppointmentLifecycleService,
    private readonly videoSessions: VideoSessionService,
    private readonly followUp: ConsultationFollowUpService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List incoming consultation requests for me' })
  list(@CurrentUser() user: User, @Query() query: ListConsultationsQueryDto) {
    return this.consultationsService.listForAstrologer(user, query.status);
  }

  @Post(':consultationId/proposals')
  @ApiOperation({
    summary:
      'Propose appointment date/time + duration for an ACCEPTED consultation (no reservation/payment)',
  })
  createProposal(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Body() dto: CreateConsultationProposalDto,
  ) {
    return this.proposalsService.createForAstrologer(user, consultationId, dto);
  }

  @Get(':consultationId/proposals')
  @ApiOperation({
    summary:
      'List proposal history for an assigned consultation (newest first)',
  })
  listProposals(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.proposalsService.listForAstrologer(user, consultationId);
  }

  @Post(':consultationId/appointment/cancel')
  @ApiOperation({
    summary:
      'Cancel own CONFIRMED appointment BEFORE its scheduled start (409 afterwards). Records a 100% customer refund obligation and a reliability incident (no refund is issued here).',
  })
  cancelAppointment(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Body() dto: CancelAppointmentDto,
  ) {
    return this.lifecycle.cancelByAstrologer(user, consultationId, dto.reason);
  }

  @Post(':consultationId/appointment/video-session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Obtain Agora RTC credentials for an assigned eligible appointment. Does not complete the consultation or record attendance.',
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
  @ApiOperation({
    summary:
      'List post-session follow-up messages for an assigned completed consultation',
  })
  listMessages(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.followUp.listForAstrologer(user, consultationId);
  }

  @Post(':consultationId/messages')
  @ApiOperation({
    summary:
      'Reply with a plain-text follow-up message while the 48h window is open',
  })
  sendMessage(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Body() dto: SendFollowUpMessageDto,
  ) {
    return this.followUp.sendForAstrologer(user, consultationId, dto.body);
  }

  @Put(':consultationId/summary')
  @ApiOperation({
    summary:
      'Create or update the optional plain-text consultation summary (completed only)',
  })
  upsertSummary(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
    @Body() dto: UpsertAstrologerSummaryDto,
  ) {
    return this.followUp.upsertSummaryForAstrologer(
      user,
      consultationId,
      dto.summary,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get consultation detail including proposals (marks PENDING viewedAt once; does not extend expiresAt)',
  })
  getOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.consultationsService.getForAstrologer(user, id, true);
  }

  @Post(':id/accept')
  @ApiOperation({
    summary:
      'Accept PENDING consultation (willingness only — no appointment/payment)',
  })
  accept(@CurrentUser() user: User, @Param('id') id: string) {
    return this.consultationsService.accept(user, id);
  }

  @Post(':id/decline')
  @ApiOperation({ summary: 'Decline PENDING consultation' })
  decline(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: DeclineConsultationDto,
  ) {
    return this.consultationsService.decline(user, id, dto);
  }
}
