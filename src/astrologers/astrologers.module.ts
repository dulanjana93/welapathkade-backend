import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AvailabilityModule } from '../availability/availability.module';
import { AstrologersController } from './astrologers.controller';
import { AstrologersMeController } from './astrologers-me.controller';
import { AstrologersService } from './astrologers.service';

@Module({
  imports: [AuditModule, AvailabilityModule],
  controllers: [AstrologersMeController, AstrologersController],
  providers: [AstrologersService],
  exports: [AstrologersService],
})
export class AstrologersModule {}
