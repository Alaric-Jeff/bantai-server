import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateNewResponderUserAccount } from './types/create-new-user.types';
import { UserIdType } from './types/user-id.types';
import { CreateResponderProfileData } from './types/create-responder-profile.type';

@Injectable()
export class UserRepository {
  constructor(private readonly db: DatabaseService) {}

  async createResponderProfile(
    userData: CreateNewResponderUserAccount,
    profileData: CreateResponderProfileData,
  ): Promise<UserIdType> {
    const { f_name, l_name, m_name, email, role, command_center_id } = userData;
    const { agency, call_sign, rank } = profileData;

    return this.db.withTransaction(async (client) => {
      const { rows } = await client.query<UserIdType>(
        `INSERT INTO user_account(f_name, l_name, m_name, email, role, command_center_id)
         VALUES($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [f_name, l_name, m_name, email, role, command_center_id],
      );
      const { id: user_id } = rows[0];

      await client.query(
        `INSERT INTO r_profile(user_id, agency, call_sign, rank)
         VALUES($1, $2, $3, $4)`,
        [user_id, agency, call_sign, rank],
      );

      return { id: user_id };
    });
  }
}
