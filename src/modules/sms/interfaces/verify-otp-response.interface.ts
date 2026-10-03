export interface VerifyOtpResponse {
  status: VerifyOtpStatusResponseEnum;
  message: string;
}

export enum VerifyOtpStatusResponseEnum {
  SUCCESS = 'success',
  ERROR = 'error',
}
