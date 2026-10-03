import { Module, NotImplementedException } from '@nestjs/common';
import { DriverController } from './drivers.controller';
import { DriverService } from './drivers.service';
import { DriverRepository } from './drivers.repository';
import { AuthModule } from '../auth/auth.module';
import { AuthProviderEnum } from '../responders/enums/auth-provider.enum';
import {
  SOCIAL_IDENTITY_VERIFIERS,
  SocialIdentityVerifiers,
} from './types/social-identity-provider.type';
import { GoogleService } from '../auth/providers/google.service';

@Module({
  imports: [AuthModule],
  controllers: [DriverController],
  providers: [
    DriverService,
    DriverRepository,
    {
      provide: SOCIAL_IDENTITY_VERIFIERS,
      useFactory: (googleService: GoogleService): SocialIdentityVerifiers => ({
        [AuthProviderEnum.GOOGLE]: {
          verify: async (idToken: string) => {
            const payload = await googleService.verifyIdToken(idToken);
            return {
              provider_id: payload.googleId,
              email: payload.email,
            };
          },
        },
        [AuthProviderEnum.APPLE]: {
          verify: () => {
            throw new NotImplementedException(
              'Apple SSO is not implemented yet',
            );
          },
        },
      }),
      inject: [GoogleService],
    },
  ],
  exports: [DriverService],
})
export class DriverModule {}
