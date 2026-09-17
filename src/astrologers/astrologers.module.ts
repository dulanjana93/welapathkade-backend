import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AstrologersController } from './astrologers.controller';
import { AstrologersMeController } from './astrologers-me.controller';
import { AstrologersService } from './astrologers.service';

@Module({
  imports: [AuditModule],
  controllers: [AstrologersMeController, AstrologersController],
  providers: [AstrologersService],
  exports: [AstrologersService],
})
export class AstrologersModule {}
