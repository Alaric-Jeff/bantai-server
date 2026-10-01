import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DriverRepository } from './drivers.repository';
import { CreateDriverDto } from './dto/create-driver.dto';
import {
  PatchDriverProfileDto,
  toDriverProfilePatch,
  toUserAccountPatch,
} from './dto/patch-driver-profile.dto';
import { CreateDriverProfileData } from './types/create-driver-profile.types';
import { CreateDriverUserAccount } from './types/create-driver-account.type';
import { DriverProfileDataRow } from './types/driver-profile-data-row.type';
import { UserAccountPatch } from './types/patch-user-account.type';
import { UserIdType } from '../responders/types/user-id.types';
import { AuthProviderEnum } from '../responders/enums/auth-provider.enum';
import { ServiceProviderEnum } from '../responders/enums/service-provider.enum';
import {
  SOCIAL_IDENTITY_VERIFIERS,
  type SocialIdentityVerifiers,
} from './types/social-identity-provider.type';

/** The identity-related columns that differ per auth provider. */
type IdentityFields = Pick<
  CreateDriverUserAccount,
  | 'email'
  | 'auth_provider'
  | 'provider_id'
  | 'password_hash'
  | 'email_verified_at'
>;

const BCRYPT_ROUNDS = 12;

// Postgres SQLSTATE codes we translate into HTTP errors.
const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';
const PG_NOT_NULL_VIOLATION = '23502';
// Class 22 = data exceptions (value too long, invalid format, out of range).
const PG_DATA_EXCEPTION_CLASS = '22';

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function isPgError(error: unknown): error is PgErrorLike {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function hasChanges(patch: object): boolean {
  return Object.values(patch).some((value) => value !== undefined);
}

/** 'YYYY-MM-DD' (already strictly validated by the DTO) strictly before now. */
function isPastDate(isoDate: string): boolean {
  return new Date(`${isoDate}T00:00:00.000Z`).getTime() < Date.now();
}

@Injectable()
export class DriverService {
  private readonly logger = new Logger(DriverService.name);

  constructor(
    private readonly driverRepository: DriverRepository,
    @Inject(SOCIAL_IDENTITY_VERIFIERS)
    private readonly socialVerifiers: SocialIdentityVerifiers,
  ) {}

  /**
   * Registers a driver. Called once the whole wizard is complete;
   * user_account + d_profile are inserted in a single transaction by the
   * repository.
   *
   * `phoneVerifiedAt` must come from your OTP layer (the controller
   * verifies dto.otp_code first), never from the request body.
   *
   * Provider-agnostic: everything that differs between email/password,
   * Google and Apple lives in resolveIdentity(); the rest of the flow is
   * identical for all of them.
   */
  async createDriver(
    dto: CreateDriverDto,
    phoneVerifiedAt: Date,
  ): Promise<UserIdType> {
    if (!isPastDate(dto.date_of_birth)) {
      throw new BadRequestException('date_of_birth must be in the past');
    }

    if (
      dto.service_provider !== ServiceProviderEnum.INDEPENDENT &&
      !dto.service_id
    ) {
      throw new BadRequestException(
        `service_id is required when service provider is ${dto.service_provider}`,
      );
    }

    const identity = await this.resolveIdentity(dto);

    const userData: CreateDriverUserAccount = {
      f_name: dto.f_name,
      l_name: dto.l_name,
      m_name: dto.m_name ?? null,
      m_number: dto.m_number,
      ...identity,
      phone_verified_at: phoneVerifiedAt,
    };

    const profileData: CreateDriverProfileData = {
      service_provider: dto.service_provider,
      // service_id_requires_provider: null for independent, a value otherwise.
      service_id:
        dto.service_provider === ServiceProviderEnum.INDEPENDENT
          ? null
          : (dto.service_id ?? null),
      plate_number: dto.plate_number,
      blood_type: dto.blood_type,
      address: dto.address,
      date_of_birth: dto.date_of_birth,
      emergency_contacts: dto.emergency_contacts,
      license_number: dto.license_number,
      license_expires_at: dto.license_expires_at,
      years_riding: dto.years_riding,
      fleet_operator_id: dto.fleet_operator_id ?? null,
      vehicle_model: dto.vehicle_model,
      vehicle_color: dto.vehicle_color,
      medical_conditions: dto.medical_conditions,
      // Stamped server-side so the audit trail can't be client-supplied.
      data_sharing_consented_at: new Date(),
    };

    try {
      return await this.driverRepository.createDriverAccount(
        userData,
        profileData,
      );
    } catch (error: unknown) {
      this.rethrowDbError(error, 'createDriver');
    }
  }

  /**
   * Partial update of the authenticated driver's account + profile.
   * Returns the fresh full profile.
   *
   * `phoneVerifiedAt` is required whenever dto.m_number is present: the
   * controller verifies dto.otp_code and passes the result here. (If a
   * number changes without it, the repository would clear verification.)
   */
  async updateProfile(
    userId: string,
    dto: PatchDriverProfileDto,
    phoneVerifiedAt?: Date,
  ): Promise<DriverProfileDataRow> {
    const accountPatch: UserAccountPatch = toUserAccountPatch(dto);
    const profilePatch = toDriverProfilePatch(dto);

    if (!hasChanges(accountPatch) && !hasChanges(profilePatch)) {
      throw new BadRequestException('No fields provided to update');
    }

    if (accountPatch.m_number !== undefined) {
      if (!phoneVerifiedAt) {
        throw new BadRequestException(
          'A new mobile number must be verified with an OTP code',
        );
      }
      accountPatch.phone_verified_at = phoneVerifiedAt;
    }

    if (
      profilePatch.date_of_birth !== undefined &&
      !isPastDate(profilePatch.date_of_birth)
    ) {
      throw new BadRequestException('date_of_birth must be in the past');
    }

    // Switching to independent drops the platform id automatically.
    if (profilePatch.service_provider === ServiceProviderEnum.INDEPENDENT) {
      profilePatch.service_id = null;
    }

    let profile: DriverProfileDataRow | null;
    try {
      profile = await this.driverRepository.patchDriverComposite(
        userId,
        accountPatch,
        profilePatch,
      );
    } catch (error: unknown) {
      this.rethrowDbError(error, 'updateProfile');
    }

    if (!profile) {
      throw new NotFoundException('Driver account not found');
    }
    return profile;
  }

  /**
   * Turns the registration's credentials into the identity columns
   * (chck_auth_requirements): a local driver has password_hash and a null
   * provider_id; a Google/Apple driver has a provider_id and no password.
   * For social providers the email comes from the VERIFIED token, never
   * from the request body.
   */
  private async resolveIdentity(dto: CreateDriverDto): Promise<IdentityFields> {
    switch (dto.auth_provider) {
      case AuthProviderEnum.LOCAL: {
        if (!dto.password) {
          throw new BadRequestException('Password is required');
        }
        return {
          email: dto.email,
          auth_provider: AuthProviderEnum.LOCAL,
          provider_id: null,
          password_hash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
          email_verified_at: null,
        };
      }

      case AuthProviderEnum.GOOGLE:
      case AuthProviderEnum.APPLE: {
        if (!dto.social_id_token) {
          throw new BadRequestException('social_id_token is required');
        }
        try {
          const verified = await this.socialVerifiers[dto.auth_provider].verify(
            dto.social_id_token,
          );
          return {
            email: verified.email.trim().toLowerCase(),
            auth_provider: dto.auth_provider,
            provider_id: verified.provider_id,
            password_hash: null,
            email_verified_at: new Date(),
          };
        } catch (error: unknown) {
          this.logger.warn(
            `${dto.auth_provider} token verification failed: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
          throw new UnauthorizedException('Invalid or expired sign-in token');
        }
      }

      default:
        throw new BadRequestException('Unsupported auth provider');
    }
  }

  /**
   * Translates Postgres errors into HTTP exceptions. Anything unexpected is
   * logged (without request data, which contains PII) and surfaced as a 500.
   */
  private rethrowDbError(error: unknown, operation: string): never {
    if (isPgError(error)) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        const constraint = error.constraint ?? '';
        this.logger.warn(
          `${operation}: unique violation (${constraint || 'unknown'})`,
        );

        if (constraint.includes('m_number')) {
          throw new ConflictException('Mobile number is already registered');
        }
        if (constraint.includes('email')) {
          throw new ConflictException('Email address is already registered');
        }
        if (constraint.includes('license_number')) {
          throw new ConflictException('License number is already registered');
        }

        throw new ConflictException(
          'An account with these details already exists',
        );
      }
      if (
        error.code === PG_CHECK_VIOLATION ||
        error.code === PG_NOT_NULL_VIOLATION ||
        error.code?.startsWith(PG_DATA_EXCEPTION_CLASS)
      ) {
        this.logger.warn(
          `${operation}: data rule violation (${error.code ?? 'unknown'}, ${error.constraint ?? 'no constraint'})`,
        );
        throw new BadRequestException('Submitted data is invalid');
      }
    }

    this.logger.error(
      `${operation} failed`,
      error instanceof Error ? error.stack : undefined,
    );
    throw new InternalServerErrorException();
  }
}
