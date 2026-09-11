import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { UserAuthRow } from './interfaces/user-auth-row.interface';
import {
  PasswordRequirementState,
  ChangedPassRow,
} from './interfaces/user-pass-change-requirement.interface';
import { Role } from '../../common/enums/role-enum';

@Injectable()
export class AuthRepository {
  constructor(private readonly db: DatabaseService) {}

  async findUserByEmail(email: string): Promise<UserAuthRow | null> {
    const sql = `
      SELECT id, password_hash, role, deleted_at, command_center_id
      FROM user_account 
      WHERE email = $1
      LIMIT 1;
    `;

    const { rows } = await this.db.query<UserAuthRow>(sql, [email]);
    return rows[0] || null;
  }

  async createSession(
    userId: string,
    refreshTokenHash: string,
    expiresAt: Date,
    role: Role,
  ): Promise<void> {
    if (role !== Role.SUPER) {
      await this.db.query(`DELETE FROM user_session WHERE user_id = $1;`, [
        userId,
      ]);
    }

    const sql = `
      INSERT INTO user_session (user_id, refresh_token_hash, expires_at)
      VALUES ($1, $2, $3);
    `;

    await this.db.query(sql, [userId, refreshTokenHash, expiresAt]);
  }

  async findUserByRefreshTokenHash(hash: string): Promise<UserAuthRow | null> {
    const sql = `
      SELECT u.id, u.password_hash, u.role, u.deleted_at, u.command_center_id 
      FROM user_account u
      INNER JOIN user_session s ON u.id = s.user_id
      WHERE s.refresh_token_hash = $1 AND s.expires_at > NOW() AND s.is_revoked = false AND u.deleted_at IS NULL
      LIMIT 1;
    `;

    const { rows } = await this.db.query<UserAuthRow>(sql, [hash]);

    return rows[0] || null;
  }

  async deleteSessionByHash(hash: string) {
    const sql = `DELETE from user_session WHERE refresh_token_hash = $1`;

    await this.db.query(sql, [hash]);
    return;
  }

  async findPasswordChangeRequirement(
    id: string,
  ): Promise<PasswordRequirementState | null> {
    const sql = 'SELECT must_change_password FROM r_profile WHERE user_id = $1';
    const { rows } = await this.db.query<PasswordRequirementState>(sql, [id]);

    return rows[0] || null;
  }

  async updateTempPassword(
    id: string,
    newPassword: string,
  ): Promise<ChangedPassRow> {
    const sql =
      'UPDATE user_accounts SET password = $1, must_change_password = $2 WHERE user_id = $3 RETURNING password, must_change_password';

    const { rows } = await this.db.query<ChangedPassRow>(sql, [
      newPassword,
      false,
      id,
    ]);

    return rows[0];
  }

  /**
   * Atomically rotates a refresh session: inserts the new session and
   * removes the old one in a single DB transaction. Either both writes
   * land or neither does — this closes the gap where a crash between
   * "create new" and "delete old" could leave duplicate/orphaned
   * sessions, or (in a non-transactional ordering) leave the user
   * without a valid session at all if the second write failed.
   *
   * BUSINESS RULE — single-session enforcement:
   * Every role except SUPER is restricted to exactly one active session
   * at a time (using the system from two devices at once doesn't make
   * sense for a driver/responder/admin in this product). SUPER is the
   * one deliberate exception, since the dev team shares that role for
   * development and needs concurrent sessions across multiple machines.
   *
   * This is why the two branches below are NOT unified into one
   * "delete by oldHash" query:
   *   - non-SUPER: deletes ALL sessions for user_id, not just oldHash.
   *     Since these roles should only ever have one session row to
   *     begin with, this is equivalent to deleting oldHash in the
   *     normal case, but is more defensive — it also cleans up any
   *     stray duplicate rows that shouldn't exist but could appear from
   *     a bug elsewhere, keeping the single-session invariant intact.
   *   - SUPER: deletes ONLY the exact oldHash being rotated. Deleting
   *     by user_id here would be wrong — it would silently log out
   *     every other team member sharing the SUPER role just because
   *     one of them refreshed their token.
   *
   * DO NOT "simplify" this by making both branches delete-by-hash or
   * both delete-by-user_id — either change breaks one of the two rules
   * above. If you need to change this logic, re-read this comment first.
   *
   * ASSUMES DatabaseService exposes withTransaction() (see
   * database.service.ts) for running multiple statements atomically
   * against a single connection.
   */
  async atomicSession(
    userId: string,
    oldHash: string,
    newHash: string,
    expiresAt: Date,
    role: Role,
  ): Promise<void> {
    await this.db.withTransaction(async (client) => {
      if (role !== Role.SUPER) {
        await client.query(`DELETE FROM user_session WHERE user_id = $1;`, [
          userId,
        ]);
      } else {
        await client.query(
          `DELETE FROM user_session WHERE refresh_token_hash = $1;`,
          [oldHash],
        );
      }

      await client.query(
        `INSERT INTO user_session (user_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, $3);`,
        [userId, newHash, expiresAt],
      );
    });
  }
}
