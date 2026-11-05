import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SavedCardCheckoutDto {
  @ApiProperty({
    description:
      'Id of the saved card the customer selected. The server checks that this card belongs to the authenticated customer and is eligible. This request does not accept an amount, currency, token, card number, or merchant reference.',
    example: 'cmcard123',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  savedCardId!: string;
}
