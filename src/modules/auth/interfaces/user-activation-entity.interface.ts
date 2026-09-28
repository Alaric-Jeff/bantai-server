import { AccountTokenPurposeEnum } from '../enums/account-token-purpose.enum';

export interface AccountActionTokenEntity {
  id: string;
  user_id: string;
  purpose: AccountTokenPurposeEnum;
  token_hash: string;
  expires_at: Date;
  used_at: Date;
  created_at: Date;
}
