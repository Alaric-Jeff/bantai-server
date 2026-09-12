import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class AuditLogsRepository {
  constructor(private readonly db: DatabaseService) {}
}
