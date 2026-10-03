export interface SendOtpRequest {
  api_token: string;
  phone_number: string;
  message: string | null;
  expires_in_minutes: number | null;
}
