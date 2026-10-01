import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export const NODEMAILER_CLIENT = 'NODEMAILER_CLIENT';

/**
 * Sends through the developer's own Gmail account via SMTP, as a
 * stopgap while no domain is verified with a real transactional
 * provider. GMAIL_APP_PASSWORD is a 16-character App Password
 * (Google Account -> Security -> 2-Step Verification -> App
 * passwords) — NOT the account's normal login password; Gmail
 * requires 2FA to be enabled before it will issue one.
 *
 * Gmail's SMTP relay enforces that the message's From address matches
 * the authenticated account (or one of its verified "Send As"
 * aliases) — unlike Resend, you can't set an arbitrary From here.
 * EMAIL_FROM should therefore be set to the same address as
 * GMAIL_USER (see email.service.ts).
 *
 * Free Gmail accounts are capped around 500 sends/day — fine for
 * development, not a production substitute for a verified domain.
 */
export const NodemailerProvider: Provider = {
  provide: NODEMAILER_CLIENT,
  useFactory: (configService: ConfigService) => {
    const user = configService.getOrThrow<string>('SMTP_USER');
    const pass = configService.getOrThrow<string>('SMTP_PASS');

    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  },
  inject: [ConfigService],
};
