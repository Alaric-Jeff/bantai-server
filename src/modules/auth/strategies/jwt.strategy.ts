import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(private readonly configService: ConfigService) {
    const secret = configService.get<string>('JWT_SECRET');

    if (!secret) {
      throw new Error('FATAL: JWT_SECRET environment variable is missing.');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });

    this.logger.log('JwtStrategy successfully initialized.');
  }

  validate(payload: JwtPayload) {
    this.logger.debug(
      `Token validated for user ID: ${payload.sub} [Role: ${payload.role}]`,
    );

    return {
      sub: payload.sub,
      role: payload.role,
      ...(payload.command_center_id && {
        command_center_id: payload.command_center_id,
      }),
    };
  }
}
