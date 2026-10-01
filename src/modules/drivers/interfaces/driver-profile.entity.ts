import { BloodTypeEnum } from '../../responders/enums/blood-type.enum';
import { ServiceProviderEnum } from '../../responders/enums/service-provider.enum';

/**
 * One element of d_profile.emergency_contacts (a JSONB array, at most
 * 3 — emergency_contacts_max_three). The keys here are the keys
 * stored inside the JSON, so they must match what the DTO sends.
 */
export interface EmergencyContact {
  name: string;
  relation: string;
  number: string;
}

/**
 * One row of d_profile, column for column, with the nullability the
 * schema actually has (including the migration 003 columns). A
 * types-and-intellisense mirror of the table — not a DTO. Narrower
 * shapes (create payloads, update patches, the joined profile view)
 * are derived from this in ./types.
 *
 * DATE columns (date_of_birth, license_expires_at) are typed `string`,
 * i.e. 'YYYY-MM-DD', because that is how the app reads and writes
 * them: DriverRepository formats them in SQL, and the DTOs carry ISO
 * date strings. (node-pg's own default would hand back a JS Date at
 * local midnight, which shifts the day in timezones ahead of UTC.)
 */
export interface DriverProfileEntity {
  user_id: string;

  service_provider: ServiceProviderEnum;
  // A platform's own driver id. Required for angkas / move_it /
  // joyride, forbidden for independent (service_id_requires_provider).
  service_id: string | null;

  plate_number: string | null;
  blood_type: BloodTypeEnum;
  address: string | null;
  date_of_birth: string | null;
  // JSONB array, max 3 (emergency_contacts_max_three).
  emergency_contacts: EmergencyContact[];

  created_at: Date;
  updated_at: Date;

  // ---- Migration 003 ----
  license_number: string;
  license_expires_at: string;
  years_riding: number;
  // Optional TODA / fleet affiliation. Unrelated to service_id.
  fleet_operator_id: string | null;
  vehicle_model: string;
  vehicle_color: string;
  medical_conditions: string;
  data_sharing_consented_at: Date;
}
