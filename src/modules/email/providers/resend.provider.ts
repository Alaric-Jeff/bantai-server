import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export const RESEND_CLIENT = 'RESEND CLIENT';

export const ResendProvider: Provider = {
  provide: RESEND_CLIENT,
  useFactory: (ConfigService: ConfigService) => {
    const apiKey = ConfigService.getOrThrow<string>('bantai_resend_api_key');
    return new Resend(apiKey);
  },
  inject: [ConfigService],
};
