import { IsNotEmpty, IsString } from 'class-validator';

export class GoogleSsoDto {
  @IsString()
  @IsNotEmpty()
  idToken!: string;
}
