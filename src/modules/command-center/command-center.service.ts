import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommandCenterRepository } from './command-center.repository';
import { CommandCenterEntity } from './interfaces/command-center.interface';
import { CreateCommandCenterDTO } from './dto/create-command-center.dto';
import { UpdateCommandCenterDTO } from './dto/update-command-center.dto';
import { UpdateCommandCenterData } from './types/update-command-center-data.types';
import { CreateCommandCenterData } from './types/create-command-center-data.types';

@Injectable()
export class CommandCenterService {
  private readonly logger = new Logger(CommandCenterService.name);

  constructor(
    private readonly commandCenterRepository: CommandCenterRepository,
  ) {}

  private sanitizeString(value?: string): string | undefined {
    if (!value) return undefined;
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async create(dto: CreateCommandCenterDTO): Promise<CommandCenterEntity> {
    const createData: CreateCommandCenterData = {
      ...dto,
      name: this.sanitizeString(dto.name)!,
      branch: this.sanitizeString(dto.branch)!,
    };

    try {
      return await this.commandCenterRepository.createBranch(createData);
    } catch (error: unknown) {
      this.logger.error(
        'An error occurred while creating new center',
        error instanceof Error ? error.stack : error,
      );
      throw new InternalServerErrorException(
        'Unknown error occurred while creating new command center',
      );
    }
  }

  async update(
    id: string,
    dto: UpdateCommandCenterDTO,
  ): Promise<CommandCenterEntity> {
    const updateData: UpdateCommandCenterData = {
      ...dto,
      ...(dto.name && { name: this.sanitizeString(dto.name) }),
      ...(dto.branch && { branch: this.sanitizeString(dto.branch) }),
    };

    let updatedCenter: CommandCenterEntity | null = null;

    try {
      updatedCenter = await this.commandCenterRepository.updateBranch(
        id,
        updateData,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Database error while attempting to update command center ${id}`,
        error instanceof Error ? error.stack : error,
      );
      throw new InternalServerErrorException(
        'An unexpected error occurred while updating the command center',
      );
    }

    if (!updatedCenter) {
      this.logger.warn(`Command center update failed: ID '${id}' not found`);
      throw new NotFoundException(`Command center with ID '${id}' not found`);
    }

    return updatedCenter;
  }

  async delete(id: string): Promise<void> {
    let isDeleted = false;

    try {
      isDeleted = await this.commandCenterRepository.deleteBranch(id);
    } catch (error: unknown) {
      this.logger.error(
        `Database error while attempting to delete command center ${id}`,
        error instanceof Error ? error.stack : error,
      );
      throw new InternalServerErrorException(
        'An unexpected error occurred while deleting the command center',
      );
    }

    if (!isDeleted) {
      this.logger.warn(`Command center deletion failed: ID '${id}' not found`);
      throw new NotFoundException(`Command center not found`);
    }
  }
}
