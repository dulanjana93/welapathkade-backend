import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, Max, Min } from 'class-validator';
import {
  MAX_APPOINTMENT_DURATION_MINUTES,
  MIN_APPOINTMENT_DURATION_MINUTES,
} from '../../availability/availability.constants';

export class CreateConsultationProposalDto {
  @ApiProperty({
    description:
      'Proposed appointment start as ISO-8601 instant (UTC). Validated against Asia/Colombo weekly availability. End time is derived server-side.',
    example: '2026-09-25T04:30:00.000Z',
  })
  @IsDateString()
  proposedStartAt!: string;

  @ApiProperty({
    description:
      'Consultation duration in minutes chosen by the astrologer. End time = start + duration. Bounds match slot enumeration.',
    example: 30,
    minimum: MIN_APPOINTMENT_DURATION_MINUTES,
    maximum: MAX_APPOINTMENT_DURATION_MINUTES,
  })
  @IsInt()
  @Min(MIN_APPOINTMENT_DURATION_MINUTES)
  @Max(MAX_APPOINTMENT_DURATION_MINUTES)
  durationMinutes!: number;
}
