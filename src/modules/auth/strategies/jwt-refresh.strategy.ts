import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { FastifyRequest } from 'fastify';
import { RequestWithCookies } from '../interfaces/request-w-cookie.interface';

function extractRefreshToken(request: FastifyRequest): string | null {
  const { cookies } = request as RequestWithCookies;
  const token = cookies?.refresh_token;

  if (!token || typeof token !== 'string') {
    return null;
  }

  return token;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  private readonly logger = new Logger(JwtRefreshStrategy.name);

  constructor(private readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extractRefreshToken]),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      passReqToCallback: true,
    });
  }

  validate(request: FastifyRequest, payload: JwtPayload) {
    const refreshToken = extractRefreshToken(request);

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token malformed or missing.');
    }

    this.logger.debug(`Refresh Token validated for user ID: ${payload.sub}`);

    return {
      sub: payload.sub,
      role: payload.role,
      refreshToken,
    };
  }
}
