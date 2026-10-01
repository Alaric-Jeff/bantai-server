import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/role.decorator';
import { Role } from '../../common/enums/role-enum';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { ResponderService } from './responders.service';
import { CreateResponderDto } from './dto/create-responder.dto';
import { UserIdType } from './types/user-id.types';

type AuthenticatedRequest = Request & { user: JwtPayload };

@Controller('responders')
@UseGuards(JwtGuard, RolesGuard)
export class RespondersController {
  constructor(private readonly responderService: ResponderService) {}

  @Post()
  @Roles(Role.ADMIN, Role.SUPER)
  async createResponder(
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    dto: CreateResponderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<UserIdType> {
    const { role, command_center_id: jwtCcId } = req.user;

    let targetCommandCenterId: string;

    if (role === Role.SUPER) {
      if (!dto.command_center_id) {
        throw new BadRequestException(
          'Superadmin must explicitly provide command_center_id in the body.',
        );
      }
      targetCommandCenterId = dto.command_center_id;
    } else {
      if (!jwtCcId) {
        throw new ForbiddenException(
          'Your account is not attached to a command center.',
        );
      }
      targetCommandCenterId = jwtCcId;
    }

    return this.responderService.createResponder(dto, targetCommandCenterId);
  }
}
