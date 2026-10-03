import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class PasswordResetDTO {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @Length(10, 128, {
    message: 'Password must be between 10 and 128 characters.',
  })
  @Matches(/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).*$/, {
    message:
      'Password must contain at least 1 uppercase letter, 1 number, and 1 special character.',
  })
  new_password!: string;
}
