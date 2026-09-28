import { Role } from '../../../common/enums/role-enum';
import { AccountStatusEnum } from '../../auth/enums/account-status.enum';
import { AuthProviderEnum } from '../enums/auth-provider.enum';

export interface UserEntity {
  id: string;
  f_name: string;
  l_name: string;
  m_name: string | null;
  email: string;
  m_number: string | null;
  role: Role;
  command_center_id: string | null;
  avatar_url: string | null;
  auth_provider: AuthProviderEnum;
  provider_id: string | null;

  /**
   * NULL while account_status is 'pending_activation' — a provisioned
   * account has no password at all until the holder activates it via a
   * single-use token. This is enforced by chck_auth_requirements, so
   * the nullability here is not defensive, it's a real state.
   */
  password_hash: string | null;

  account_status: AccountStatusEnum;

  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
