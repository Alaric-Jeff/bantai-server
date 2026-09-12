import { GeoPoint } from '../../../common/interfaces/geo-location.interface';
import { CCEnum } from '../enums/cc.enum';

export interface CommandCenterEntity {
  id: string;
  name: string;
  type: CCEnum;
  branch: string;
  location: GeoPoint;
  created_at: Date;
}
