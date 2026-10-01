import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export const RESEND_CLIENT = 'RESEND_CLIENT';

export const ResendProvider: Provider = {
  provide: RESEND_CLIENT,
  useFactory: (configService: ConfigService) => {
    const apiKey = configService.getOrThrow<string>('RESEND_API_KEY');
    return new Resend(apiKey);
  },
  inject: [ConfigService],
};
