import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { AccountTokenPurposeEnum } from '../enums/account-token-purpose.enum';

export class createActivationTokenDTO {
  @IsString()
  @IsNotEmpty()
  user_id!: string;

  @IsEnum(AccountTokenPurposeEnum)
  @IsNotEmpty()
  purpose!: AccountTokenPurposeEnum;

  @IsString()
  @IsNotEmpty()
  token_hash!: string;
}
