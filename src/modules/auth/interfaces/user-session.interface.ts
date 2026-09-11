import { Role } from '../../../common/enums/role-enum';

export interface UserSessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  role?: Role;
}
