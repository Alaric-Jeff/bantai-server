import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

const MOBILE_PATTERN = /^\+639\d{9}$/;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * One element of d_profile.emergency_contacts (a JSONB array, 1 to 3
 * entries). The ONE definition shared by the create and patch DTOs,
 * so the keys stored in the JSON ({ name, relation, number }) can
 * never drift between registration and a later edit.
 */
export class EmergencyContactDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  relation!: string;

  @Matches(MOBILE_PATTERN, {
    message: 'contact number must be a valid PH mobile number',
  })
  number!: string;
}
