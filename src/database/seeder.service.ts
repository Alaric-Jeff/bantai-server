import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from './database.service';
import { Role } from '../common/enums/role-enum';

@Injectable()
export class SeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeederService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    await this.seedSuperAdmin();
  }

  private async seedSuperAdmin(): Promise<void> {
    const email = this.configService.get<string>('SUPERADMIN_EMAIL');
    const rawPassword = this.configService.get<string>('SUPERADMIN_PASSWORD');

    if (!email || !rawPassword) {
      this.logger.warn(
        'SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD not defined in .env. Skipping seed.',
      );
      return;
    }

    try {
      const existingUser = await this.db.query(
        'SELECT id FROM user_account WHERE email = $1 OR role = $2 LIMIT 1',
        [email, Role.SUPER],
      );

      if (existingUser.rowCount && existingUser.rowCount > 0) {
        this.logger.log('Superadmin account already present. Skipping seed.');
        return;
      }

      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(rawPassword, saltRounds);

      await this.db.query(
        `INSERT INTO user_account (email, password_hash, role, f_name, l_name, m_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO NOTHING`,
        [email, hashedPassword, Role.SUPER, 'Super', 'Admin', '+639763172042'],
      );

      this.logger.log(`Superadmin account seeded successfully: ${email}`);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during seeding';
      this.logger.error(`Failed to seed Superadmin account: ${errorMessage}`);
    }
  }
}
