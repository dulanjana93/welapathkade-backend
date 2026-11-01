import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PaymentsService } from './payments.service';
import { SavedCardService } from './saved-card.service';

@ApiTags('Payments')
@Controller('payments/callbacks')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly savedCards: SavedCardService,
  ) {}

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

  @Post('payhere')
  @HttpCode(200)
  @ApiConsumes('application/x-www-form-urlencoded')
  @ApiBody({
    description:
      'PayHere payment notification. Not JSON. A valid md5sig is required. The browser return URL is not accepted as proof of payment.',
    schema: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string' },
        order_id: { type: 'string' },
        payment_id: { type: 'string' },
        payhere_amount: { type: 'string' },
        payhere_currency: { type: 'string' },
        status_code: { type: 'string' },
        md5sig: { type: 'string' },
      },
      required: [
        'merchant_id',
        'order_id',
        'payhere_amount',
        'payhere_currency',
        'status_code',
        'md5sig',
      ],
    },
  })
  @ApiOperation({
    summary: 'PayHere server notification',
    description:
      'Public callback. An order id starting with pa_ is a saved-card pre-approval and never creates a consultation payment. An order id starting with sc_ is a saved-card charge and uses the same verified payment finalizer as checkout (wp_). Status 2 finalizes a live reservation. Status 0 stays pending. Status -1 and -2 fail the attempt. Status -3 is recorded as a chargeback and is never a success. A verified success after the 30-minute hold records the capture and a full refund obligation without confirming the appointment. Card fields and customer tokens are not stored.',
  })
  handlePayHere(@Req() req: Request) {
    const fields = payHereFields(req.body);
    if (fields.order_id?.startsWith('pa_')) {
      return this.savedCards.handleNotify(fields);
    }
    return this.payments.handlePayHereNotify(fields);
  }
}

function payHereFields(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Malformed PayHere notification');
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Malformed PayHere notification');
    }
    fields[key] = value;
  }
  if (Object.keys(fields).length === 0) {
    throw new BadRequestException('Malformed PayHere notification');
  }
  return fields;
}
