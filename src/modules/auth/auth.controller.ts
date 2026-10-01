import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import ms from 'ms';
import { AuthService, INVALID_LINK_MESSAGE } from './auth.service';
import { EmailPasswordDto } from './dto/email-password.dto';
import { ActionTokenPasswordDto } from './dto/action-token-password.dto';
import { ReplyWithCookie } from './interfaces/reply-w-cookie.interface';
import { AuthTokens } from './interfaces/auth-token.interface';
import { GoogleLoginDto } from './dto/google-sso.dto';

interface RequestWithCookies extends FastifyRequest {
  cookies: Record<string, string | undefined>;
}

const REFRESH_COOKIE_NAME = 'refresh_token';

// Raw account-action tokens are 64 hex chars; anything much longer is junk.
const MAX_ACTION_TOKEN_LENGTH = 128;

@Controller('auth')
export class AuthController {
  private readonly refreshCookiePath: string;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    const apiPrefix = this.configService
      .get<string>('API_PREFIX', '/api/v1')
      .replace(/\/$/, '');
    this.refreshCookiePath = `${apiPrefix}/auth/refresh`;
  }

  @HttpCode(HttpStatus.OK)
  @Post('local/signin')
  async localSignIn(
    @Body() dto: EmailPasswordDto,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<AuthTokens> {
    const tokens = await this.authService.manualLogin(dto);

    this.setRefreshTokenCookie(response, tokens.refreshToken);

    return tokens;
  }

  @HttpCode(HttpStatus.OK)
  @Post('google')
  async googleSignIn(
    @Body() dto: GoogleLoginDto,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<AuthTokens> {
    const tokens = await this.authService.googleLogin(dto.social_id_token);

    this.setRefreshTokenCookie(response, tokens.refreshToken);

    return tokens;
  }

  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() request: RequestWithCookies,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<AuthTokens> {
    const existingToken = request.cookies?.[REFRESH_COOKIE_NAME];

    if (!existingToken) {
      throw new UnauthorizedException('No refresh token provided.');
    }

    const tokens = await this.authService.refreshToken(existingToken);

    this.setRefreshTokenCookie(response, tokens.refreshToken);

    return tokens;
  }

  // ------------------------------------------------------------------
  // Emailed-link flows (account activation / password reset).
  //
  // Public on purpose: the holder has no session yet, and the
  // single-use token IS the credential. Responses are no-store so a
  // token-bearing URL or its result is never cached by a browser or
  // proxy.
  // ------------------------------------------------------------------

  @Get('verify-activation-token')
  @Header('Cache-Control', 'no-store')
  verifyActivationToken(
    @Query('token') token?: string,
  ): Promise<{ maskedEmail: string }> {
    return this.authService.verifyActivationToken(
      this.requireActionToken(token),
    );
  }

  @Get('verify-reset-token')
  @Header('Cache-Control', 'no-store')
  verifyResetToken(
    @Query('token') token?: string,
  ): Promise<{ maskedEmail: string }> {
    return this.authService.verifyPasswordResetToken(
      this.requireActionToken(token),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('activate')
  @Header('Cache-Control', 'no-store')
  async activate(
    @Body() dto: ActionTokenPasswordDto,
  ): Promise<{ message: string }> {
    await this.authService.activateAccount(dto.token, dto.password);
    return { message: 'Account activated.' };
  }

  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  @Header('Cache-Control', 'no-store')
  async resetPassword(
    @Body() dto: ActionTokenPasswordDto,
  ): Promise<{ message: string }> {
    await this.authService.resetPassword(dto.token, dto.password);
    return { message: 'Password reset.' };
  }

  /**
   * A missing, non-string, or absurdly long ?token= gets the same
   * generic message as an expired link, so the response never hints
   * at what was wrong with it.
   */
  private requireActionToken(token: unknown): string {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_ACTION_TOKEN_LENGTH
    ) {
      throw new BadRequestException(INVALID_LINK_MESSAGE);
    }
    return token;
  }

  private setRefreshTokenCookie(
    response: FastifyReply,
    refreshToken: string,
  ): void {
    const refreshTtl = this.configService.getOrThrow<string>(
      'JWT_REFRESH_EXPIRATION',
    );
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const maxAgeInSeconds = ms(refreshTtl as ms.StringValue) / 1000;

    (response as ReplyWithCookie).setCookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: this.refreshCookiePath,
      maxAge: maxAgeInSeconds,
    });
  }
}
