import { UserAccountEntity } from '../interfaces/user-account-entity.interface';
import { AuthProviderEnum } from '../../responders/enums/auth-provider.enum';
import { UserIdentity } from '../../../common/interfaces/user-identity-entity.interface';

/**
 * The user_account + user_identity payload shape required for driver creation.
 */
export type CreateDriverUserAccount = Omit<
  Pick<
    UserAccountEntity,
    | 'f_name'
    | 'l_name'
    | 'm_name'
    | 'email'
    | 'password_hash'
    | 'phone_verified_at'
    | 'email_verified_at'
  >,
  'm_number'
> & {
  m_number: NonNullable<UserAccountEntity['m_number']>;

  // Decoupled auth fields
  auth_provider: AuthProviderEnum;
  provider_id: UserIdentity['provider_id'] | null;
};
