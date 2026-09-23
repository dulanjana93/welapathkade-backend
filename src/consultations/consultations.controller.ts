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
  CreateConsultationDto,
  ListConsultationsQueryDto,
} from './dto/consultation.dto';

@ApiTags('Consultations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('consultations')
export class ConsultationsController {
  constructor(
    private readonly consultationsService: ConsultationsService,
    private readonly proposalsService: ConsultationProposalsService,
  ) {}

  @Post()
  @Roles(UserRole.PUBLIC)
  @ApiOperation({
    summary: 'Create a consultation request (preferred time only — no reservation)',
  })
  create(@CurrentUser() user: User, @Body() dto: CreateConsultationDto) {
    return this.consultationsService.create(user, dto);
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
