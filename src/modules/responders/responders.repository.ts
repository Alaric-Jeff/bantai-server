import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateNewResponderUserAccount } from './types/create-new-user.types';
import { UserIdType } from './types/user-id.types';
import { CreateResponderProfileData } from './types/create-responder-profile.type';
import { AccountStatusEnum } from '../auth/enums/account-status.enum';

@Injectable()
export class ResponderRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Creates the user_account row, and — ONLY when profileData is
   * given — the matching r_profile row. profileData is omitted for
   * admin accounts: r_profile is responder-only data (agency,
   * call_sign, rank), and agency is NOT NULL in that table, so an
   * unconditional insert here would throw a raw Postgres constraint
   * violation the moment ResponderService creates an admin instead of
   * a responder.
   */
  async createResponderProfile(
    userData: CreateNewResponderUserAccount,
    profileData?: CreateResponderProfileData,
  ): Promise<UserIdType> {
    const { f_name, l_name, m_name, email, role, command_center_id } = userData;

    return this.db.withTransaction(async (client) => {
      const { rows } = await client.query<UserIdType>(
        `INSERT INTO user_account(f_name, l_name, m_name, email, role, command_center_id, account_status)
         VALUES($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          f_name,
          l_name,
          m_name,
          email,
          role,
          command_center_id,
          AccountStatusEnum.PENDING_ACTIVATION,
        ],
      );
      const { id: user_id } = rows[0];

      if (profileData) {
        const { agency, call_sign, rank } = profileData;
        await client.query(
          `INSERT INTO r_profile(user_id, agency, call_sign, rank)
           VALUES($1, $2, $3, $4)`,
          [user_id, agency, call_sign, rank],
        );
      }

      return { id: user_id };
    });
  }
}
