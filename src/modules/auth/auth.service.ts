import {
  Injectable,
  UnauthorizedException,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import ms from 'ms';
import { AuthRepository } from './auth.repository';
import { EmailPasswordDto } from './dto/email-password.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { Role } from '../../common/enums/role-enum';
import { AuthTokens } from './interfaces/auth-token.interface';
import { EmailService } from '../email/email.service';
import { CreateActivationTokenData } from './types/create-activation-token.types';
import { AccountTokenPurposeEnum } from './enums/account-token-purpose.enum';
import { AccountStatusEnum } from './enums/account-status.enum';

interface SignedTokens extends AuthTokens {
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

/**
 * Maps each account-action token purpose to the config key holding
 * its TTL. Keeping this as a lookup (rather than branching in code)
 * means adding a new purpose later is a one-line addition here plus
 * a new .env key — no new if/switch needed.
 */
const TOKEN_TTL_CONFIG_KEY: Record<AccountTokenPurposeEnum, string> = {
  [AccountTokenPurposeEnum.ACTIVATION]: 'ACTIVATION_TOKEN_EXPIRATION',
  [AccountTokenPurposeEnum.PASSWORD_RESET]: 'PASSWORD_RESET_TOKEN_EXPIRATION',
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  private createPayload(
    userId: string,
    role: Role,
    commandCenterId?: string | null,
  ): JwtPayload {
    return {
      sub: userId,
      role: role,
      ...(commandCenterId && { command_center_id: commandCenterId }),
    };
  }

  /**
   * Fast, deterministic hash used for both refresh tokens and account
   * action tokens. SHA-256 (not bcrypt/argon2) is correct here because
   * the input is a high-entropy random secret, not a low-entropy
   * user-chosen password — there's nothing to slow down an attacker
   * guessing, so a fast hash keeps lookups cheap without any security
   * trade-off.
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Pure token signing — no DB writes. Produces a fresh access/refresh
   * pair plus the refresh token's hash and expiry, so callers can decide
   * how to persist the session (a plain insert for a new login, or an
   * atomic rotate-in-transaction for a refresh).
   *
   * The refresh token payload includes a random `jti` (JWT ID). Without
   * it, two refresh tokens signed for the same user within the same
   * wall-clock second are byte-for-byte IDENTICAL: the JWT `iat` claim
   * only has 1-second resolution, HS256 signing is fully deterministic
   * (no randomness), and the payload was otherwise just `{ sub: userId }`.
   * That meant a login followed by an immediate refresh (or two refreshes
   * within the same second) could produce the exact same token twice,
   * silently defeating rotation — the "new" session would hash-collide
   * with the "old" one instead of being a genuinely distinct credential.
   * A random UUID per signing call guarantees uniqueness regardless of
   * timing, with no other behavior change.
   */
  private async signTokens(
    userId: string,
    role: Role,
    commandCenterId?: string | null,
  ): Promise<SignedTokens> {
    const payload = this.createPayload(userId, role, commandCenterId);

    const accessTtl = this.configService.getOrThrow<string>('JWT_EXPIRATION');
    const refreshTtl = this.configService.getOrThrow<string>(
      'JWT_REFRESH_EXPIRATION',
    );

    const accessExpiresInSec = Math.floor(
      ms(accessTtl as ms.StringValue) / 1000,
    );
    const refreshExpiresInSec = Math.floor(
      ms(refreshTtl as ms.StringValue) / 1000,
    );

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
        expiresIn: accessExpiresInSec,
      }),
      this.jwtService.signAsync(
        { sub: userId, jti: randomUUID() },
        {
          secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: refreshExpiresInSec,
        },
      ),
    ]);

    const refreshTokenHash = this.hashToken(refreshToken);
    const refreshExpiresAt = new Date(
      Date.now() + ms(refreshTtl as ms.StringValue),
    );

    return { accessToken, refreshToken, refreshTokenHash, refreshExpiresAt };
  }

  async generateTokens(
    userId: string,
    role: Role,
    commandCenterId?: string | null,
  ): Promise<AuthTokens> {
    const { accessToken, refreshToken, refreshTokenHash, refreshExpiresAt } =
      await this.signTokens(userId, role, commandCenterId);

    await this.authRepository.createSession(
      userId,
      refreshTokenHash,
      refreshExpiresAt,
      role,
    );

    return { accessToken, refreshToken };
  }

  async manualLogin(dto: EmailPasswordDto): Promise<AuthTokens> {
    const { email, password } = dto;

    try {
      const user = await this.authRepository.findUserByEmail(email);

      if (!user) {
        this.logger.warn(`Failed login attempt for email: ${email}`);
        throw new UnauthorizedException('Invalid email or password.');
      }

      if (user.deleted_at !== null) {
        this.logger.warn(`Deactivated account tried to authenticate: ${email}`);
        throw new UnauthorizedException('Invalid email or password.');
      }

      if (!user.password_hash) {
        this.logger.warn(
          `Account with no local password attempted local login: ${email}`,
        );
        throw new UnauthorizedException('Invalid email or password.');
      }

      const isPasswordValid = await bcrypt.compare(
        password,
        user.password_hash,
      );
      if (!isPasswordValid) {
        this.logger.warn(`Invalid password for email: ${email}`);
        throw new UnauthorizedException('Invalid email or password.');
      }

      return await this.generateTokens(
        user.id,
        user.role,
        user.command_center_id,
      );
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      this.logger.error(`Error during local login for email ${email}`, err);
      throw new InternalServerErrorException('Authentication failed.');
    }
  }

  /**
   * Core token-issuing routine shared by both activation and
   * password-reset flows. Generates a random raw secret, hashes it for
   * storage, computes expiry from the purpose's configured TTL,
   * invalidates any previously-live token for the same user+purpose
   * (per the migration's app-layer requirement — the DB's unique index
   * only allows one live token per user per purpose), and persists the
   * new row.
   *
   * @param userId Account the token is being issued for.
   * @param purpose Which flow this token authorizes — `activation` or
   *   `password_reset`. Determines both the TTL config key used here
   *   and, at redemption time, which state transition is valid.
   * @returns The RAW (unhashed) token. This is the only value that
   *   should ever be emailed to the user — it is never persisted
   *   anywhere itself, only its SHA-256 hash is.
   */
  private async generateActionToken(
    userId: string,
    purpose: AccountTokenPurposeEnum,
  ): Promise<string> {
    // Invalidate any existing unused token for this user+purpose first,
    // so the insert below never collides with
    // uq_account_action_token_live_per_purpose.
    await this.authRepository.invalidateLiveToken(userId, purpose);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    const ttlConfigKey = TOKEN_TTL_CONFIG_KEY[purpose];
    const ttl = this.configService.getOrThrow<string>(ttlConfigKey);
    const expiresAt = new Date(Date.now() + ms(ttl as ms.StringValue));

    const data: CreateActivationTokenData = {
      user_id: userId,
      purpose,
      token_hash: tokenHash,
      expires_at: expiresAt,
    };

    await this.authRepository.createAccountActionToken(data);

    return rawToken;
  }

  /**
   * Issues an activation token for a `pending_activation` account and
   * emails the activation link to the account holder. This is the
   * only way a provisioned admin/responder/super account can ever
   * receive a password — there is no temporary password generated
   * anywhere in this flow.
   *
   * Called immediately after account provisioning (e.g. an admin
   * creating a responder via user_account + r_profile), which is why
   * this takes `email` directly rather than looking it up — the
   * caller already has it from the `INSERT ... RETURNING id` +
   * creation DTO, so no extra DB round-trip is needed here.
   *
   * @param userId The freshly-provisioned account's id. Must
   *   currently be in `pending_activation` status.
   * @param email Address to send the activation link to.
   * @throws {BadRequestException} If the account doesn't exist or is
   *   not in `pending_activation` status.
   */
  async createActivationToken(userId: string, email: string): Promise<void> {
    const state = await this.authRepository.checkUserActivationState(userId);

    if (
      !state ||
      state.account_status !== AccountStatusEnum.PENDING_ACTIVATION
    ) {
      this.logger.warn(
        `Activation token requested for non-pending account: ${userId}`,
      );
      throw new BadRequestException('Account is not pending activation.');
    }

    try {
      const rawToken = await this.generateActionToken(
        userId,
        AccountTokenPurposeEnum.ACTIVATION,
      );

      await this.emailService.sendActivationEmail(email, rawToken);
    } catch (err: unknown) {
      this.logger.error(
        `Failed to create/send activation token for user ${userId}`,
        err instanceof Error ? err.stack : err,
      );
      throw new InternalServerErrorException(
        'Failed to send activation email.',
      );
    }
  }

  /**
   * Rotates a refresh session atomically: signs a new token pair, then
   * persists it via atomicSession, which — in a single DB transaction —
   * removes the old session (by user_id for non-SUPER roles, by exact
   * oldHash for SUPER, see auth.repository.ts for why) and inserts the
   * new one. Either both the delete and the insert land, or neither
   * does, so a mid-operation failure can never leave the user without
   * any valid session, nor leave two sessions behind for a role that's
   * supposed to be single-session.
   */
  async refreshToken(token: string): Promise<AuthTokens> {
    try {
      await this.jwtService.verifyAsync(token, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch (err) {
      this.logger.warn(`Refresh token verification failed: ${err}`);
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    const oldHash = this.hashToken(token);

    try {
      const user =
        await this.authRepository.findUserByRefreshTokenHash(oldHash);

      if (!user) {
        this.logger.warn(
          'Attempted token refresh with unrecognized, expired, or revoked hash.',
        );
        throw new UnauthorizedException('Invalid session.');
      }

      const { accessToken, refreshToken, refreshTokenHash, refreshExpiresAt } =
        await this.signTokens(user.id, user.role, user.command_center_id);

      await this.authRepository.atomicSession(
        user.id,
        oldHash,
        refreshTokenHash,
        refreshExpiresAt,
        user.role,
      );

      return { accessToken, refreshToken };
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      this.logger.error('Error during token refresh', err);
      throw new InternalServerErrorException('Token refresh failed.');
    }
  }
}
