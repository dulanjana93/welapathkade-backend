import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  REGISTRATION_CLIENT_OUTCOMES,
  type RegistrationClientOutcome,
} from '../saved-card.service';

export class CompletePreapprovalDto {
  @ApiPropertyOptional({
    enum: REGISTRATION_CLIENT_OUTCOMES,
    description:
      'What the app saw when the PayHere page closed: RETURNED (return_url), CANCELLED (cancel_url), or CLOSED (WebView closed). Informational only. It can end an attempt early but never activates a card.',
  })
  @IsOptional()
  @IsIn(REGISTRATION_CLIENT_OUTCOMES)
  outcome?: RegistrationClientOutcome;
}
