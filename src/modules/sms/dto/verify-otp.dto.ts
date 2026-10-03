import { SendOtpDto } from './send-otp.dto';
import { Matches } from 'class-validator';

export class VerifyOtpDto extends SendOtpDto {
  @Matches(/^\d{6}$/, { message: 'otp_code must be a 6-digit code' })
  otp_code!: string;
}
