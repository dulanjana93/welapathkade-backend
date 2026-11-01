import { ApiProperty } from '@nestjs/swagger';
import { Equals } from 'class-validator';

export class StartPreapprovalDto {
  @ApiProperty({
    description:
      'Must be true. Accepts the current automatic-payment consent, including future consultation charges and the PayHere Rs. 1.00 verification charge and refund.',
    example: true,
  })
  @Equals(true)
  acceptAutomaticPaymentConsent!: boolean;
}
