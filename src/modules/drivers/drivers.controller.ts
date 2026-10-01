import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/role.decorator';
import { Role } from '../../common/enums/role-enum';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { DriverService } from './drivers.service';
import { CreateDriverDto } from './dto/create-driver.dto';
import { PatchDriverProfileDto } from './dto/patch-driver-profile.dto';
import { UserIdType } from '../responders/types/user-id.types';

type AuthenticatedRequest = Request & { user: JwtPayload };

@Controller('drivers')
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

  /**
   * Public Endpoint: Driver Self-Registration.
   * Unprotected because drivers register themselves during onboarding.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    dto: CreateDriverDto,
  ): Promise<UserIdType> {
    // Stamped here until OTP layer is hooked into the controller
    const phoneVerifiedAt = new Date();

    return this.driverService.createDriver(dto, phoneVerifiedAt);
  }

  /**
   * Protected Endpoint: Driver Profile Update.
   * Restricted strictly to authenticated users with the DRIVER role.
   */
  @Patch('profile')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(Role.DRIVER)
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    dto: PatchDriverProfileDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.user.sub;
    const phoneVerifiedAt = dto.m_number ? new Date() : undefined;

    return this.driverService.updateProfile(userId, dto, phoneVerifiedAt);
  }
}
