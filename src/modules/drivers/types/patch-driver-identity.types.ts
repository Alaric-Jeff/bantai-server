import { DriverProfileEntity } from '../interfaces/driver-profile.entity';
/**
 * Columns the schema leaves nullable but the wizard always fills, so a
 * patch may replace them and never clear them.
 */
type NeverClearedKeys = 'plate_number' | 'address' | 'date_of_birth';

type PatchableProfileKeys =
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
  | 'medical_conditions';

/**
 * What a driver may change on d_profile. Every key is optional
 * (omitted = leave alone). `null` is only valid for service_id and
 * fleet_operator_id. data_sharing_consented_at is excluded: consent
 * changes deserve their own flow.
 *
 * service_provider and service_id travel together
 * (service_id_requires_provider): a value for angkas / move_it /
 * joyride, null for independent. The service nulls service_id
 * automatically when switching to independent.
 */
export type DriverProfilePatch = Partial<
  Omit<Pick<DriverProfileEntity, PatchableProfileKeys>, NeverClearedKeys> & {
    [K in NeverClearedKeys]: NonNullable<DriverProfileEntity[K]>;
  }
>;
