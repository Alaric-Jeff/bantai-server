import { BloodTypeEnum } from '../enums/blood-type.enum';
import { ServiceProviderEnum } from '../enums/service-provider.enum';

export type EmergencyContact = {
  name: string;
  relationship: string;
  phone: string;
};

export interface DriverProfileEntity {
  user_id: string;
  service_provider: ServiceProviderEnum;
  service_id: string | null;

  plate_number: string | null;
  blood_type: BloodTypeEnum;
  address: string | null;
  date_of_birth: Date | null;
  emergency_contacts: EmergencyContact[];

  created_at: Date;
  updated_at: Date;
}
