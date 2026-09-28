import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import ms from 'ms';
import { AuthService } from './auth.service';
import { EmailPasswordDto } from './dto/email-password.dto';
import { ReplyWithCookie } from './interfaces/reply-w-cookie.interface';
import { AuthTokens } from './interfaces/auth-token.interface';

interface RequestWithCookies extends FastifyRequest {
  cookies: Record<string, string | undefined>;
}

const REFRESH_COOKIE_NAME = 'refresh_token';

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
