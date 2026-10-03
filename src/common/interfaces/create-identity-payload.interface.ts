import { AuthProviderEnum } from '../../modules/responders/enums/auth-provider.enum';
import { UserIdentityData } from './user-identity-entity.interface';
export interface CreateUserIdentityPayload {
  userId: string;
  provider: AuthProviderEnum;
  providerId: string;
  providerEmail?: string | null;
  identityData?: UserIdentityData;
}
