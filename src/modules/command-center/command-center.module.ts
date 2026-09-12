import { Module } from '@nestjs/common';
import { CommandCenterController } from './command-center.controller';
import { CommandCenterService } from './command-center.service';
import { CommandCenterRepository } from './command-center.repository';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [CommandCenterController],
  providers: [CommandCenterService, CommandCenterRepository],
})
export class CommandCenterModule {}
