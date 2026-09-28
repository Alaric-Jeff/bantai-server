import { ResponderProfileEntity } from '../interface/responder-profile-entity.interface';

export type CreateResponderProfileData = Pick<
  ResponderProfileEntity,
  'agency' | 'call_sign' | 'rank'
>;
