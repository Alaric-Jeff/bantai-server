// src/modules/auth/guards/roles.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { Role } from '../enums/role-enum';
import { ROLES_KEY } from '../decorators/role.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles are explicitly required by the endpoint, let it pass
    // (authentication is still handled separately by the JwtGuard).
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();

    const user = request.user;

    if (!user || !user.role) {
      this.logger.warn(
        `Role check failed: Unauthenticated or missing user role context on ${request.url}`,
      );
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Access denied: insufficient permissions',
        code: 'FORBIDDEN_RESOURCE',
      });
    }

    const hasRole = requiredRoles.includes(user.role);

    if (!hasRole) {
      this.logger.warn(
        `Access violation: User ${user.sub} with role '${user.role}' attempted to access restricted endpoint ${request.url}. Required roles: [${requiredRoles.join(', ')}]`,
      );
      throw new ForbiddenException(
        'Unauthorized Access: Insufficient Permissions',
      );
    }

    return true;
  }
}
