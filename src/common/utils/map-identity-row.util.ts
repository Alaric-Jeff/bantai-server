import {
  UserIdentity,
  UserIdentityRow,
} from '../interfaces/user-identity-entity.interface';

export function mapUserIdentityRowToEntity(row: UserIdentityRow): UserIdentity {
  return {
    id: row.id,
    user_id: row.user_id,
    provider: row.provider,
    provider_id: row.provider_id,
    provider_email: row.provider_email,
    identity_data: row.identity_data ?? {},
    last_sign_in_at: row.last_sign_in_at ? new Date(row.last_sign_in_at) : null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    deleted_at: row.deleted_at ? new Date(row.deleted_at) : null,
  };
}
