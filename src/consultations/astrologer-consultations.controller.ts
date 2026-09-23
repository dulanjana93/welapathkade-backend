import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole, type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ConsultationProposalsService } from './consultation-proposals.service';
import { ConsultationsService } from './consultations.service';
import {
  DeclineConsultationDto,
  ListConsultationsQueryDto,
} from './dto/consultation.dto';
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
  ) {}

  @Get()
  @ApiOperation({ summary: 'List incoming consultation requests for me' })
  list(
    @CurrentUser() user: User,
    @Query() query: ListConsultationsQueryDto,
  ) {
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
    return this.proposalsService.createForAstrologer(
      user,
      consultationId,
      dto,
    );
  }

  @Get(':consultationId/proposals')
  @ApiOperation({
    summary: 'List proposal history for an assigned consultation (newest first)',
  })
  listProposals(
    @CurrentUser() user: User,
    @Param('consultationId') consultationId: string,
  ) {
    return this.proposalsService.listForAstrologer(user, consultationId);
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
