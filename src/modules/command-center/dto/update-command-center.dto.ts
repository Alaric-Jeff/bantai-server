// Use this if you have Swagger
import { PartialType } from '@nestjs/swagger';
import { CreateCommandCenterDTO } from './create-command-center.dto';

export class UpdateCommandCenterDTO extends PartialType(
  CreateCommandCenterDTO,
) {}
