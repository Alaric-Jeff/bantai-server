import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import ms from 'ms';
import { AuthService } from './auth.service';
import { EmailPasswordDto } from './dto/email-password.dto';
import { ReplyWithCookie } from './interfaces/reply-w-cookie.interface';
import { AuthTokens } from './interfaces/auth-token.interface';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ChangedPassDTO } from './dto/change-temp-password.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/role.decorator';
import { Role } from '../../common/enums/role-enum';

// Fastify's request type doesn't know about @fastify/cookie's `cookies`
// property unless the plugin's type augmentation is registered globally.
// Narrowing it locally here keeps this file compiling regardless of
// whether that global augmentation is set up yet.
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
    // IMPORTANT: this must match the app's global prefix (see main.ts's
    // app.setGlobalPrefix(apiPrefix)) + this controller's actual route,
    // or the browser/client's cookie jar will refuse to attach the
    // cookie on refresh — it only sends a cookie back if the request
    // path starts with the cookie's declared Path attribute. Building
    // it from the same API_PREFIX config value main.ts uses means this
    // can never silently drift out of sync again.
    const apiPrefix = this.configService
      .get<string>('API_PREFIX', '/api/v1')
      .replace(/\/$/, ''); // strip trailing slash if present
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
  @Post('forced_password_reset')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER, Role.RESPONDER)
  async forcedPasswordReset(
    @Req() req: FastifyRequest & { user: AuthenticatedUser },
    @Body() dto: ChangedPassDTO,
  ) {
    const id: string = req.user.sub;
    return await this.authService.changeTempPassword(id, dto);
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
