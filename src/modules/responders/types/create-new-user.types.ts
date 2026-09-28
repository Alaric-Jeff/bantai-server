import { UserEntity } from '../interface/user-entity.interface';

/**
 * account_status deliberately excluded — a newly provisioned account
 * must ALWAYS start 'pending_activation'. Letting a caller supply this
 * would allow accidentally (or maliciously) creating an already-'active'
 * account with no password_hash, which chck_auth_requirements would
 * reject anyway — but the invalid state shouldn't even be
 * representable at the type level in the first place.
 */
export type CreateNewResponderUserAccount = Pick<
  UserEntity,
  'f_name' | 'l_name' | 'm_name' | 'email' | 'role' | 'command_center_id'
>;
