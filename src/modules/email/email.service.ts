import {
  Injectable,
  Inject,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { ConfigService } from '@nestjs/config';
import { NODEMAILER_CLIENT } from './providers/nodemailer.provider';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(NODEMAILER_CLIENT) private readonly transporter: Transporter,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Low-level send — any caller-provided subject/HTML goes straight
   * out via SMTP. Purpose-specific methods below should be preferred
   * so the copy/branding for each email type lives in one place.
   *
   * The sender address comes from EMAIL_FROM. With the Gmail/SMTP
   * transport currently wired in (see nodemailer.provider.ts), Gmail
   * enforces that this matches the authenticated account (GMAIL_USER)
   * or one of its verified "Send As" aliases — a mismatched From here
   * gets silently rewritten by Gmail rather than honored, so keep
   * EMAIL_FROM equal to GMAIL_USER while this provider is in use.
   *
   * nodemailer.sendMail REJECTS its promise on failure (unlike
   * Resend's client, which returned an { error } field instead of
   * throwing) — hence the try/catch here rather than an `if (error)`
   * check.
   *
   * @param to Recipient email address.
   * @param subject Email subject line.
   * @param html Full HTML body.
   * @throws {InternalServerErrorException} If the SMTP send fails.
   */
  async sendEmail(to: string, subject: string, html: string) {
    const from = this.configService.getOrThrow<string>('EMAIL_FROM');

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return await this.transporter.sendMail({ from, to, subject, html });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `SMTP failed to send "${subject}" to ${to}: ${message}`,
      );
      throw new InternalServerErrorException(
        `Email failed to send: ${message}`,
      );
    }
  }

  /**
   * Builds an absolute, correctly-encoded link back to the app using
   * FRONTEND_URL from config, so links point at a page with a form
   * rather than the bare API, and so the base URL doesn't need to be
   * hardcoded per environment (local/staging/prod).
   *
   * @param path Route path, e.g. '/activate' or '/reset-password'.
   * @param rawToken The UNHASHED token — this is the only place the
   *   raw secret exists outside the moment it was generated and
   *   hashed. It is never persisted anywhere as plaintext.
   */
  private buildActionUrl(path: string, rawToken: string): string {
    const baseUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    const url = new URL(path, baseUrl);
    url.searchParams.set('token', rawToken);
    return url.toString();
  }

  /**
   * Sends the account-activation email containing a single-use link.
   * The account has no password yet — this link is the only way for
   * the holder to set one and move the account to `active`.
   *
   * NOTE ON REAL DELIVERY: this currently sends through your own
   * Gmail account (nodemailer.provider.ts) as a stopgap while no
   * domain is verified with a real transactional provider — see
   * GMAIL_USER / GMAIL_APP_PASSWORD / EMAIL_FROM. It reaches any real
   * inbox today, capped around 500 sends/day on a free Gmail account.
   * Swap back to a verified-domain provider (e.g. Resend, once a
   * domain is verified) before relying on this for production volume.
   *
   * @param to Recipient email address (the newly provisioned user).
   * @param rawToken Unhashed activation token.
   */
  async sendActivationEmail(to: string, rawToken: string): Promise<void> {
    const activationUrl = this.buildActionUrl('/activate', rawToken);

    const html = `
      <p>Welcome to BANTAI! Your account has been created.</p>
      <p>Click the link below to activate your account and set your password:</p>
      <p><a href="${activationUrl}">Activate your account</a></p>
      <p>This link will expire in 24 hours. If you didn't expect this email, you can safely ignore it.</p>
    `;

    await this.sendEmail(to, 'Activate your BANTAI account', html);
  }

  /**
   * Sends the password-reset email containing a single-use link. Used
   * both for self-service "forgot password" and for an
   * admin-triggered compromise-response reset on an already-active
   * account — same template either way.
   *
   * @param to Recipient email address.
   * @param rawToken Unhashed password-reset token.
   */
  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    const resetUrl = this.buildActionUrl('/reset-password', rawToken);

    const html = `
      <p>We received a request to reset your BANTAI account password.</p>
      <p><a href="${resetUrl}">Reset your password</a></p>
      <p>This link will expire in 1 hour. If you didn't request this, you can safely ignore this email — your password won't be changed.</p>
    `;

    await this.sendEmail(to, 'Reset your BANTAI password', html);
  }
}
