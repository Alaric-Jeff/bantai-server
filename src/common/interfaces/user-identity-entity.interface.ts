import { AuthProviderEnum } from '../../modules/responders/enums/auth-provider.enum';
export interface UserIdentityData {
  avatarUrl?: string;
  emailVerified?: boolean;
  rawProfile?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UserIdentity {
  id: string;
  user_id: string;
  provider: AuthProviderEnum;
  provider_id: string;
  provider_email: string | null;
  identity_data: UserIdentityData;
  last_sign_in_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: AuthProviderEnum;
  provider_id: string;
  provider_email: string | null;
  identity_data: UserIdentityData;
  last_sign_in_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
