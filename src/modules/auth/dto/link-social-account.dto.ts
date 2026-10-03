import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { AuthProviderEnum } from '../../responders/enums/auth-provider.enum';

export class LinkSocialAccountDto {
  @IsEnum(AuthProviderEnum)
  @IsNotEmpty()
  provider!: AuthProviderEnum;

  @IsString()
  @IsNotEmpty()
  idToken!: string;
}
