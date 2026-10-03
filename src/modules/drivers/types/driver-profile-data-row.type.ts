import { DriverProfileEntity } from '../interfaces/driver-profile.entity';
import { UserAccountEntity } from '../interfaces/user-account-entity.interface';
/**
 * Everything the Edit Profile screen needs in ONE record:
 * user_account + d_profile joined. This is the row shape returned by
 * DriverRepository.findProfileById and by the patch (which returns
 * the fresh record so the app can replace its cached copy).
 *
 * Derived from the two table entities, so it can only contain real
 * columns. Left out on purpose: password_hash, provider_id, role,
 * account_status, command_center_id, deleted_at, created_at (nothing
 * on the screen uses them, and the first four must never reach the
 * client), and the duplicate user_id.
 *
 * Dates (date_of_birth, license_expires_at) are 'YYYY-MM-DD' strings,
 * formatted in SQL — see DriverProfileEntity for why.
 *
 * updated_at is the LATER of the two rows' updated_at, so it changes
 * whenever anything in this record changes. Clients and controllers
 * can use it as a cache validator (ETag / If-None-Match).
 */
export type DriverProfileDataRow = Pick<
  UserAccountEntity,
  | 'id'
  | 'f_name'
  | 'm_name'
  | 'l_name'
  | 'email'
  | 'm_number'
  // | 'avatar_url'
  // | 'auth_provider'
  | 'phone_verified_at'
> &
  Pick<
    DriverProfileEntity,
    | 'service_provider'
    | 'service_id'
    | 'fleet_operator_id'
    | 'plate_number'
    | 'blood_type'
    | 'address'
    | 'date_of_birth'
    | 'emergency_contacts'
    | 'license_number'
    | 'license_expires_at'
    | 'years_riding'
    | 'vehicle_model'
    | 'vehicle_color'
    | 'medical_conditions'
    | 'data_sharing_consented_at'
  > & {
    updated_at: Date;
  };
