import {
  Injectable,
  Inject,
  InternalServerErrorException,
} from '@nestjs/common';
import { Resend } from 'resend';
import { ConfigService } from '@nestjs/config';
import { RESEND_CLIENT } from './providers/resend.provider';

@Injectable()
export class EmailService {
  constructor(
    @Inject(RESEND_CLIENT) private readonly resend: Resend,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Low-level send — any caller-provided subject/HTML goes straight to
   * Resend. Purpose-specific methods below should be preferred so the
   * copy/branding for each email type lives in one place.
   *
   * @param to Recipient email address.
   * @param subject Email subject line.
   * @param html Full HTML body.
   * @throws {InternalServerErrorException} If Resend reports a send failure.
   */
  async sendEmail(to: string, subject: string, html: string) {
    const { data, error } = await this.resend.emails.send({
      from: 'onboarding@resend.dev', // Replace with your verified domain in production
      to: [to],
      subject,
      html,
    });

    if (error) {
      throw new InternalServerErrorException(
        `Email failed to send: ${error.message}`,
      );
    }

    return data;
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
