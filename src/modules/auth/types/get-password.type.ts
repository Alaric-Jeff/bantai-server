import { UserAccountEntity } from '../../drivers/interfaces/user-account-entity.interface';

export type PasswordType = Pick<UserAccountEntity, 'password_hash'>;
