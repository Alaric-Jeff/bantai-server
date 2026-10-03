import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { CommandCenterModule } from './modules/command-center/command-center.module';
import { EmailModule } from './modules/email/email.module';
import { validate } from './config/env.config';
import { RespondersModule } from './modules/responders/responders.module';
import { DriverModule } from './modules/drivers/drivers.module';
import { SmsModule } from './modules/sms/sms.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    DatabaseModule,
    AuthModule,
    CommandCenterModule,
    EmailModule,
    RespondersModule,
    DriverModule,
    SmsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
