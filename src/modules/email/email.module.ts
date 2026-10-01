import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { ResendProvider } from './providers/resend.provider';
import { NodemailerProvider } from './providers/nodemailer.provider';

@Module({
  providers: [EmailService, ResendProvider, NodemailerProvider],
  exports: [EmailService],
})
export class EmailModule {}
