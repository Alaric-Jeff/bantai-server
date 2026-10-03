import { Matches } from 'class-validator';

export class SendOtpDto {
  @Matches(/^\+639\d{9}$/, {
    message: 'm_number must be a valid PH mobile number (+639XXXXXXXXX)',
  })
  m_number!: string;
}
