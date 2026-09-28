import { AccountActionTokenEntity } from '../interfaces/user-activation-entity.interface';

export type CreateActivationTokenData = Omit<
  AccountActionTokenEntity,
  'id' | 'used_at' | 'created_at'
>;
