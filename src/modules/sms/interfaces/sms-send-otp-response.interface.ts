import { VerifyOtpStatusResponseEnum } from './verify-otp-response.interface';

export interface SendOtpResponse {
  status: VerifyOtpStatusResponseEnum;
  message: string;
  data?: DataResponse;
}

export interface DataResponse {
  otp_code: string;
  otp_code_expires_at: string;
  otp_code_confirmed: boolean;
  phone_number: string;
  message: string;
}
