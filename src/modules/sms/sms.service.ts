import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizePhoneNumber } from './utils/normalize-sms';
import { SendOtpRequest } from './interfaces/sms-send-option.interface';
import { SendOtpResponse } from './interfaces/sms-send-otp-response.interface';
import { VerifyOtpRequest } from './interfaces/verify-otp-request.interface';
import {
  VerifyOtpResponse,
  VerifyOtpStatusResponseEnum,
} from './interfaces/verify-otp-response.interface';

const OTP_TTL_MINUTES = 10;
const REQUEST_TIMEOUT_MS = 8_000;

/** What callers get back. Deliberately NOT the provider's response: see sendOtp. */
export interface OtpDispatchResult {
  expires_in_seconds: number;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  private readonly apiToken: string;
  private readonly sendOtpUrl: string;
  private readonly verifyOtpUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.apiToken = this.configService.get<string>('IPROGSMS_API_TOKEN', '');
    this.sendOtpUrl = this.configService.get<string>(
      'IPROGSMS_SEND_OTP_URL',
      'https://www.iprogsms.com/api/v1/otp/send_otp',
    );
    this.verifyOtpUrl = this.configService.get<string>(
      'IPROGSMS_VERIFY_OTP_URL',
      'https://www.iprogsms.com/api/v1/otp/verify_otp',
    );
  }

  /**
   * Sends an OTP through iProgSMS (which generates and stores the code).
   *
   * Returns only the expiry. iProg's response includes the plaintext code
   * in data.otp_code; if that ever reached the client, anyone could "verify"
   * any number without owning it. It is never returned or logged.
   */
  async sendOtp(phoneNumber: string): Promise<OtpDispatchResult> {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const result = { expires_in_seconds: OTP_TTL_MINUTES * 60 };

    this.assertConfigured();

    const payload: SendOtpRequest = {
      api_token: this.apiToken,
      phone_number: normalizedPhone,
      // iProg's default text says "valid for 5 minutes", which would
      // contradict expires_in_minutes. :otp is filled in on their side.
      message: `Your B.A.N.T.A.I. code is :otp. It expires in ${OTP_TTL_MINUTES} minutes. Never share it - B.A.N.T.A.I. dispatch will never ask for it.`,
      expires_in_minutes: OTP_TTL_MINUTES,
    };

    const body = await this.post<SendOtpResponse>(this.sendOtpUrl, payload);

    // Fail closed: only an explicit 'success' counts.
    if (body?.status !== VerifyOtpStatusResponseEnum.SUCCESS) {
      this.logger.error(
        `iProg send_otp rejected: ${body?.message ?? 'no response body'}`,
      );
      // The provider's message can expose account details (credits,
      // token problems), so the client gets a generic one.
      throw new ServiceUnavailableException(
        'Could not send the verification code. Please try again.',
      );
    }

    this.logger.log('iProg OTP dispatched');
    return result;
  }

  /** Resolves only on a confirmed-correct code; throws otherwise. */
  async verifyOtp(phoneNumber: string, otpCode: string): Promise<void> {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    this.assertConfigured();

    const payload: VerifyOtpRequest = {
      api_token: this.apiToken,
      phone_number: normalizedPhone,
      otp: otpCode,
    };

    const body = await this.post<VerifyOtpResponse>(this.verifyOtpUrl, payload);

    if (body === null || /invalid token/i.test(body.message ?? '')) {
      this.logger.error(
        `iProg verify_otp unusable: ${body?.message ?? 'non-JSON response'}`,
      );
      throw new ServiceUnavailableException(
        'Verification is temporarily unavailable. Please try again shortly.',
      );
    }

    if (body.status !== VerifyOtpStatusResponseEnum.SUCCESS) {
      throw new BadRequestException('Invalid or expired verification code');
    }
  }

  private assertConfigured(): void {
    if (!this.apiToken) {
      this.logger.error('IPROGSMS_API_TOKEN is missing in environment config.');
      throw new InternalServerErrorException('SMS service misconfiguration');
    }
  }

  private async post<T>(url: string, payload: object): Promise<T | null> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return (await response.json().catch(() => null)) as T | null;
    } catch (error: unknown) {
      this.logger.error(
        `iProg request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new ServiceUnavailableException(
        'SMS provider is unavailable. Please try again shortly.',
      );
    }
  }
}
