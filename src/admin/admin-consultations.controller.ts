import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminConsultationsService } from './admin-consultations.service';
import { AdminConsultationsQueryDto } from './dto/admin-consultations.dto';

@ApiTags('Admin Consultations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/consultations')
export class AdminConsultationsController {
  constructor(private readonly consultations: AdminConsultationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated admin consultation list (read-only)',
    description:
      'Filters on appointmentStatus, paymentStatus, hasRefundObligation, and manualReviewRequired match a consultation when ANY related appointment satisfies the filter. Each list row still displays the latest appointment by createdAt DESC, which may differ from the appointment that matched the filter. This endpoint never expires consultations/reservations, never mutates lifecycle, and never calls payment providers.',
  })
  list(@Query() query: AdminConsultationsQueryDto) {
    return this.consultations.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Admin consultation operational detail (read-only)',
    description:
      'Returns consultation, customer, astrologer, proposals, appointments, payment summaries, refund obligations, PayHere refund records, financial snapshots, and ledger entries as separate fields. Missing lifecycle records are null or []. Never calls PayHere Retrieval or mutates state.',
  })
  get(@Param('id') id: string) {
    return this.consultations.getById(id);
  }
}
