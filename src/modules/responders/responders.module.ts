import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ResponderRepository } from './responders.repository';
import { ResponderService } from './responders.service';
import { RespondersController } from './responders.controller';
@Module({
  imports: [AuthModule],
  providers: [ResponderService, ResponderRepository],
  controllers: [RespondersController],
  exports: [ResponderService],
})
export class RespondersModule {}
