import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { GoogleUserProfile } from '../interfaces/google-user-profile.interface';

@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);
  private readonly oauthClient: OAuth2Client;
  private readonly clientId: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.getOrThrow<string>(
      'GOOGLE_CLIENT_ID_TEST',
    );
    this.oauthClient = new OAuth2Client(this.clientId);
    this.logger.log(
      `GoogleService initialized with Client ID: ${this.clientId}`,
    );
  }

  /**
   * Cryptographically verifies the Google ID token issued to the Flutter app.
   * Returns verified user profile metadata for account provisioning.
   */
  async verifyIdToken(idToken: string): Promise<GoogleUserProfile> {
    const startTime = Date.now();
    const tokenSnippet = idToken ? `${idToken.substring(0, 15)}...` : 'EMPTY';

    this.logger.debug(
      `Starting Google ID token verification (Token Snippet: ${tokenSnippet}, Expected Audience: ${this.clientId})`,
    );

    try {
      const ticket = await this.oauthClient.verifyIdToken({
        idToken,
        audience: this.clientId,
      });

      const payload = ticket.getPayload();

      if (!payload) {
        this.logger.warn('Google OAuth2 ticket returned empty payload.');
        throw new UnauthorizedException(
          'Google token payload missing essential claims',
        );
      }

      this.logger.debug(
        `Token decrypted successfully. Payload claims -> sub: ${payload.sub}, email: ${payload.email}, email_verified: ${payload.email_verified}`,
      );

      if (!payload.email || !payload.sub) {
        this.logger.warn(
          `Google token payload rejected due to missing required claims. Payload: ${JSON.stringify(payload)}`,
        );
        throw new UnauthorizedException(
          'Google token payload missing essential claims',
        );
      }

      if (!payload.email_verified) {
        this.logger.warn(
          `Google authentication rejected for unverified email: ${payload.email}`,
        );
        throw new UnauthorizedException('Google email account is unverified');
      }

      const profile: GoogleUserProfile = {
        googleId: payload.sub,
        email: payload.email.toLowerCase(),
        firstName: payload.given_name,
        lastName: payload.family_name,
        picture: payload.picture,
      };

      const duration = Date.now() - startTime;
      this.logger.log(
        `Google token verified successfully for email: ${profile.email} (${duration}ms)`,
      );

      return profile;
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof UnauthorizedException) {
        this.logger.warn(
          `Google verification business logic failure (${duration}ms): ${error.message}`,
        );
        throw error;
      }

      // Capture and log internal library/cryptographic errors (Audience mismatch, Expired signature, network issues)
      const errMessage = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        `Cryptographic Google token verification failed (${duration}ms): ${errMessage}`,
        errStack,
      );

      throw new UnauthorizedException('Invalid or expired Google token');
    }
  }
}
