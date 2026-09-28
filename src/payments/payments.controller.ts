import {
  Body,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Controller('payments/callbacks')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('mock')
  @ApiOperation({
    summary:
      'Mock gateway notify (dev/test only). Server verifies and finalizes. Disabled in production.',
  })
  handleMock(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.payments.handleMockNotify(JSON.stringify(body ?? {}), headers);
  }
}
