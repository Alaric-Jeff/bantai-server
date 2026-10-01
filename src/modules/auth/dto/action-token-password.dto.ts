import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for POST /auth/activate and POST /auth/reset-password.
 *
 * Password strength: the SPA shows a live checklist from
 * PASSWORD_RULES (utils/passwordPolicy.ts), but the client is only UX
 * — the server must enforce the same rules. Mirror each rule from
 * that file here as an extra @Matches(...) so the two can't disagree.
 * MinLength(8) below is only the floor.
 *
 * MaxLength(72): bcrypt silently ignores everything past 72 bytes, so
 * a longer password would be accepted but only partly checked at
 * login. Reject it instead.
 *
 * The password is deliberately NOT trimmed — spaces are valid
 * characters and changing it would make login fail.
 */
export class ActionTokenPasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  token!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(72)
  password!: string;
}
