import { AuthProviderEnum } from '../../responders/enums/auth-provider.enum';

/** The providers that authenticate with an ID token instead of a password. */
export type SocialAuthProvider =
  AuthProviderEnum.GOOGLE | AuthProviderEnum.APPLE;

/**
 * What a verifier hands back after it has checked an ID token's signature,
 * audience, issuer and expiry. Implementations MUST reject tokens whose
 * email is not verified, so the service can trust `email` as-is.
 */
export interface VerifiedSocialIdentity {
  /** The provider's stable user id (the token's `sub` claim). */
  provider_id: string;
  email: string;
}

/** One implementation per provider; wrap GoogleService / an Apple equivalent. */
export interface SocialIdentityVerifier {
  verify(idToken: string): Promise<VerifiedSocialIdentity>;
}

export type SocialIdentityVerifiers = Record<
  SocialAuthProvider,
  SocialIdentityVerifier
>;

/** Nest injection token for the provider -> verifier map. */
export const SOCIAL_IDENTITY_VERIFIERS = Symbol('SOCIAL_IDENTITY_VERIFIERS');
