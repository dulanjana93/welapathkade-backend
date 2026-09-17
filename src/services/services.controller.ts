import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ServicesService } from './services.service';

@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  @ApiOperation({ summary: 'List active platform services (public catalog)' })
  @ApiOkResponse({ description: 'ACTIVE services only' })
  list() {
    return this.servicesService.listActivePublic();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an active service by id' })
  get(@Param('id') id: string) {
    return this.servicesService.getActivePublicById(id);
  }
}
