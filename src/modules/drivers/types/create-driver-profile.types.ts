import { DriverProfileEntity } from '../interfaces/driver-profile.entity';
/**
 * Columns the wizard guarantees at registration even though the
 * schema leaves them nullable (they predate migration 003 and were
 * never made NOT NULL). The create payload therefore requires them,
 * while the table type itself stays an honest 1:1 mirror.
 */
type RequiredAtRegistration = 'plate_number' | 'address' | 'date_of_birth';

type DriverProfileInsertKeys =
  | 'service_provider'
  | 'service_id'
  | 'plate_number'
  | 'blood_type'
  | 'address'
  | 'date_of_birth'
  | 'emergency_contacts'
  | 'license_number'
  | 'license_expires_at'
  | 'years_riding'
  | 'fleet_operator_id'
  | 'vehicle_model'
  | 'vehicle_color'
  | 'medical_conditions'
  | 'data_sharing_consented_at';

/**
 * The d_profile columns the driver INSERT supplies. user_id comes
 * from the user_account insert in the same transaction, and
 * created_at / updated_at are database-managed.
 *
 * service_id and fleet_operator_id are `string | null`, not optional:
 * the caller states "none" explicitly. service_id must be null for
 * `independent` and a value for every other provider.
 * data_sharing_consented_at is stamped by the service from the
 * consent checkbox, never accepted from the client.
 */
export type CreateDriverProfileData = Omit<
  Pick<DriverProfileEntity, DriverProfileInsertKeys>,
  RequiredAtRegistration
> & {
  [K in RequiredAtRegistration]: NonNullable<DriverProfileEntity[K]>;
};
