import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppointmentStatus,
  ConsultationStatus,
  PaymentStatus,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

function optionalBoolean({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === true || value === 'true' || value === '1') {
    return true;
  }
  if (value === false || value === 'false' || value === '0') {
    return false;
  }
  return value;
}

/**
 * Query for GET /admin/consultations.
 *
 * Appointment/payment/refund filters match a consultation when **any** related
 * appointment satisfies the filter. List rows still show the latest appointment
 * by createdAt DESC, which may differ from the appointment that matched.
 */
export class AdminConsultationsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({ enum: ConsultationStatus })
  @IsOptional()
  @IsEnum(ConsultationStatus)
  status?: ConsultationStatus;

  @ApiPropertyOptional({ description: 'Exact customer User.id' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Exact AstrologerProfile.id' })
  @IsOptional()
  @IsString()
  astrologerId?: string;

  @ApiPropertyOptional({
    description:
      'Inclusive UTC start (ISO-8601) for Consultation.submittedAt. Half-open with `to`.',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description:
      'Exclusive UTC end (ISO-8601) for Consultation.submittedAt. Half-open with `from`.',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'Exact consultation id, or customer phone/name / astrologer displayName search. Does not search messages or attachments.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  q?: string;

  @ApiPropertyOptional({
    enum: AppointmentStatus,
    description:
      'Matches consultations with any appointment in this status. The list row still shows the latest appointment by createdAt.',
  })
  @IsOptional()
  @IsEnum(AppointmentStatus)
  appointmentStatus?: AppointmentStatus;

  @ApiPropertyOptional({
    enum: PaymentStatus,
    description:
      'Matches consultations with any appointment payment in this status. The list row still shows the latest appointment by createdAt.',
  })
  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  @ApiPropertyOptional({
    description:
      'When true, consultations with any appointment that has a non-null refundObligation. When false, none of the appointments have an obligation.',
  })
  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  hasRefundObligation?: boolean;

  @ApiPropertyOptional({
    description:
      'When true, consultations with any appointment requiring manual review. When false, no appointment has the flag.',
  })
  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  manualReviewRequired?: boolean;
}
