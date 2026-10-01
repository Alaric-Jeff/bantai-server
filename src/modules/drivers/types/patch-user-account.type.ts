import { UserAccountEntity } from '../interfaces/user-account-entity.interface';
/**
 * What a driver may change on user_account. Every key is optional
 * (omitted = leave alone).
 *
 * Deliberately NOT patchable: email (changing it without verification
 * would let a stolen session take over the account via password
 * reset), avatar_url (no upload flow yet), role, account_status,
 * auth_provider, provider_id, password_hash.
 *
 * m_name may be null (clearing it). m_number may not: the wizard
 * requires a number, so a patch can replace it but never remove it.
 *
 * phone_verified_at is set by the service when a changed number was
 * OTP-verified in the same request; otherwise the repository clears
 * it whenever m_number actually changes.
 */
export type UserAccountPatch = Partial<
  Omit<
    Pick<
      UserAccountEntity,
      'f_name' | 'l_name' | 'm_name' | 'm_number' | 'phone_verified_at'
    >,
    'm_number'
  > & {
    m_number: NonNullable<UserAccountEntity['m_number']>;
  }
>;
