import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { GoogleUserProfile } from '../interfaces/google-user-profile.interface';

@Injectable()
export class GoogleService {
  private readonly oauthClient: OAuth2Client;
  private readonly clientId: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID');
    this.oauthClient = new OAuth2Client(this.clientId);
  }

  /**
   * Cryptographically verifies the Google ID token issued to the Flutter app.
   * Returns verified user profile metadata for account provisioning.
   */
  async verifyIdToken(idToken: string): Promise<GoogleUserProfile> {
    try {
      const ticket = await this.oauthClient.verifyIdToken({
        idToken,
        audience: this.clientId,
      });

      const payload = ticket.getPayload();

      if (!payload || !payload.email || !payload.sub) {
        throw new UnauthorizedException(
          'Google token payload missing essential claims',
        );
      }

      if (!payload.email_verified) {
        throw new UnauthorizedException('Google email account is unverified');
      }

      return {
        googleId: payload.sub,
        email: payload.email.toLowerCase(),
        firstName: payload.given_name,
        lastName: payload.family_name,
        picture: payload.picture,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired Google token');
    }
  }
}
