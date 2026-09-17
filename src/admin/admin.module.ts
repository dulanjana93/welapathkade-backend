import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminServicesController } from './admin-services.controller';
import { AdminAstrologersController } from './admin-astrologers.controller';
import { AstrologersModule } from '../astrologers/astrologers.module';
import { ServicesModule } from '../services/services.module';

@Module({
  imports: [AuthModule, ServicesModule, AstrologersModule],
  controllers: [AdminServicesController, AdminAstrologersController],
})
export class AdminModule {}
