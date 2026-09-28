import { GeoPoint } from '../../../common/interfaces/geo-location.interface';
import { AgencyTypeEnum } from '../enums/agency-type.enum';
import { AvailabilityStatusEnum } from '../enums/availability-status.enum';
import { PoliceRank } from '../enums/police-rank.enum';

export interface ResponderProfileEntity {
  user_id: string;
  agency: AgencyTypeEnum;

  call_sign: string | null;
  rank: PoliceRank;

  availability: AvailabilityStatusEnum;
  last_active_at: Date | null;
  last_known_location: GeoPoint | null;
  unit: string | null;

  created_at: Date;
  updated_at: Date;
}
