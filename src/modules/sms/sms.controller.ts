import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { OtpDispatchResult, SmsService } from './sms.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

const bodyPipe = new ValidationPipe({ whitelist: true, transform: true });

@Controller('sms/otp')
export class SmsController {
  constructor(private readonly smsService: SmsService) {}

  @Post('send')
  @HttpCode(HttpStatus.ACCEPTED)
  send(@Body(bodyPipe) dto: SendOtpDto): Promise<OtpDispatchResult> {
    return this.smsService.sendOtp(dto.m_number);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body(bodyPipe) dto: VerifyOtpDto): Promise<{ verified: true }> {
    await this.smsService.verifyOtp(dto.m_number, dto.otp_code);
    return { verified: true };
  }
}
