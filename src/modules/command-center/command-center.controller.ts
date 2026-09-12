import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CommandCenterService } from './command-center.service';
import { CreateCommandCenterDTO } from './dto/create-command-center.dto';
import { UpdateCommandCenterDTO } from './dto/update-command-center.dto';
import { CommandCenterEntity } from './interfaces/command-center.interface';
import { Roles } from '../../common/decorators/role.decorator';
import { Role } from '../../common/enums/role-enum';

@Controller('command-centers')
@UseGuards(JwtGuard, RolesGuard)
export class CommandCenterController {
  constructor(private readonly commandCenterService: CommandCenterService) {}

  @Post()
  @Roles(Role.SUPER)
  async create(
    @Body() dto: CreateCommandCenterDTO,
  ): Promise<CommandCenterEntity> {
    return this.commandCenterService.create(dto);
  }

  @Patch(':id')
  @Roles(Role.SUPER)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCommandCenterDTO,
  ): Promise<CommandCenterEntity> {
    return this.commandCenterService.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    return this.commandCenterService.delete(id);
  }
}
