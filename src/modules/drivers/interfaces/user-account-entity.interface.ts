import { Role } from '../../../common/enums/role-enum';
import { AccountStatusEnum } from '../../auth/enums/account-status.enum';

export interface UserAccountEntity {
  id: string;
  f_name: string;
  l_name: string;
  m_name: string | null;
  email: string;
  m_number: string | null;
  role: Role;
  command_center_id: string | null;

  avatar_url: string | null;
  // auth_provider: AuthProviderEnum;
  // provider_id: string | null; both are deprecated
  password_hash: string | null;
  account_status: AccountStatusEnum;

  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;

  email_verified_at: Date | null;
  phone_verified_at: Date | null;
}
