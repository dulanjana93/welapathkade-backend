import { ApiProperty } from '@nestjs/swagger';
import { Equals } from 'class-validator';

export class SavedCardCheckoutDto {
  @ApiProperty({
    description:
      'Must be true. Confirms the customer wants this consultation charged to their saved card. The amount is the accepted consultation price on the server. This request does not accept an amount, currency, token, or merchant reference.',
    example: true,
  })
  @Equals(true)
  confirmSavedCardPayment!: boolean;
}
