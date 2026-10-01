import { UserAccountEntity } from '../interfaces/user-account-entity.interface';
/**
 * The user_account columns the driver INSERT supplies.
 *
 * Left out on purpose: id, created_at, updated_at, deleted_at
 * (database-generated), role (DriverRepository always writes
 * Role.DRIVER), account_status (the column default, 'active', is
 * what a driver row must have), command_center_id (drivers have none,
 * per branch_scope_check), and avatar_url.
 *
 * m_number is tightened from the table's `string | null` to `string`:
 * the schema allows it to be empty, but the wizard always collects
 * and OTP-verifies a number, so a create payload always has one.
 *
 * Identity fields travel as a set: a local driver has password_hash
 * and a null provider_id, a Google driver the reverse
 * (chck_auth_requirements). phone_verified_at is the moment the OTP
 * was consumed.
 */
export type CreateDriverUserAccount = Omit<
  Pick<
    UserAccountEntity,
    | 'f_name'
    | 'l_name'
    | 'm_name'
    | 'email'
    | 'm_number'
    | 'auth_provider'
    | 'provider_id'
    | 'password_hash'
    | 'phone_verified_at'
    | 'email_verified_at'
  >,
  'm_number'
> & {
  m_number: NonNullable<UserAccountEntity['m_number']>;
};
