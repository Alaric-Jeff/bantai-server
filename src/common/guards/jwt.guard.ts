import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class JwtGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtGuard.name);

  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  override handleRequest<TUser = AuthenticatedUser>(
    err: unknown,
    user: unknown,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (err || !user) {
      const infoError = info instanceof Error ? info : null;
      const errError = err instanceof Error ? err : null;

      if (infoError?.name === 'TokenExpiredError') {
        this.logger.debug(
          `Expired token attempt from IP ${request.ip} on ${request.url}`,
        );
        throw new UnauthorizedException({
          statusCode: 401,
          message: 'Token expired',
          code: 'TOKEN_EXPIRED',
        });
      }

      if (infoError?.name === 'JsonWebTokenError') {
        this.logger.warn(
          `Malformed/Tampered JWT attempt from IP ${request.ip} on ${request.url}. Error: ${infoError.message}`,
        );
        throw new UnauthorizedException({
          statusCode: 401,
          message: 'Invalid token',
          code: 'TOKEN_INVALID',
        });
      }

      const fallbackMessage =
        infoError?.message || errError?.message || 'No token provided';
      this.logger.warn(
        `Auth failure from IP ${request.ip} on ${request.url}: ${fallbackMessage}`,
      );

      throw (
        errError ||
        new UnauthorizedException({
          statusCode: 401,
          message: 'Unauthorized access',
          code: 'UNAUTHORIZED',
        })
      );
    }

    const authenticatedUser = user as Record<string, unknown>;

    // We check for 'userId' here because the Guard evaluates the output of your Strategy,
    // which has already mapped 'sub' to 'userId' via the AuthenticatedUser interface.
    if (!('sub' in authenticatedUser)) {
      this.logger.error(
        `Token validated but missing 'userId' payload. IP: ${request.ip}`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid token payload schema',
        code: 'TOKEN_MALFORMED',
      });
    }

    return user as TUser;
  }
}
