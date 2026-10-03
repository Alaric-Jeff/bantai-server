import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { UserAuthRow } from './interfaces/user-auth-row.interface';
import { Role } from '../../common/enums/role-enum';
import { ActivationStateRow } from './interfaces/activation-state-row.interface';
import { CreateActivationTokenData } from './types/create-activation-token.types';
import { AccountTokenPurposeEnum } from './enums/account-token-purpose.enum';
import { AuthProviderEnum } from '../responders/enums/auth-provider.enum';
import { UpdatePasswordData } from './interfaces/update-password.interface';
import { PasswordType } from './types/get-password.type';

@Injectable()
export class AuthRepository {
  constructor(private readonly db: DatabaseService) {}

  async findUserByEmail(email: string): Promise<UserAuthRow | null> {
    // account_status is selected so login can reject pending_activation
    // accounts (which have a NULL password_hash) before comparing.
    const sql = `
      SELECT id, password_hash, role, account_status, deleted_at, command_center_id
      FROM user_account 
      WHERE email = $1 AND deleted_at IS NULL
      LIMIT 1;
    `;

    const { rows } = await this.db.query<UserAuthRow>(sql, [email]);
    return rows[0] || null;
  }

  async findUserById(id: string): Promise<UserAuthRow | null> {
    const sql = `
      SELECT id, email, password_hash, role, account_status, deleted_at, command_center_id
      FROM user_account
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1;
    `;
    const { rows } = await this.db.query<UserAuthRow>(sql, [id]);
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
      WHERE s.refresh_token_hash = $1 
        AND s.expires_at > NOW() 
        AND s.is_revoked = false 
        AND u.deleted_at IS NULL
      LIMIT 1;
    `;

    const { rows } = await this.db.query<UserAuthRow>(sql, [hash]);

    return rows[0] || null;
  }

  async deleteSessionByHash(hash: string): Promise<void> {
    const sql = `DELETE FROM user_session WHERE refresh_token_hash = $1`;

    await this.db.query(sql, [hash]);
  }

  async checkUserActivationState(id: string): Promise<ActivationStateRow> {
    const sql = 'SELECT account_status FROM user_account WHERE id = $1';
    const { rows } = await this.db.query<ActivationStateRow>(sql, [id]);
    return rows[0];
  }

  /**
   * For the two GET verify endpoints. Returns the token's owner only if
   * the token is live AND the account is in the state that purpose
   * requires (activation -> pending_activation, reset -> active), so a
   * token can't be used against the wrong kind of account.
   */
  async findLiveTokenWithUser(
    tokenHash: string,
    purpose: AccountTokenPurposeEnum,
  ): Promise<{ user_id: string; email: string } | null> {
    const sql = `
      SELECT t.user_id, u.email
      FROM account_action_token t
      JOIN user_account u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.purpose = $2
        AND t.used_at IS NULL
        AND t.expires_at > now()
        AND u.deleted_at IS NULL
        AND (
          (t.purpose = 'activation'     AND u.account_status = 'pending_activation')
          OR (t.purpose = 'password_reset' AND u.account_status = 'active')
        )
      LIMIT 1;
    `;
    const { rows } = await this.db.query<{ user_id: string; email: string }>(
      sql,
      [tokenHash, purpose],
    );
    return rows[0] || null;
  }

  /**
   * Looks up a user by third-party provider identity (e.g. Google, Apple)
   * in the decoupled `user_identity` table.
   */
  async findUserBySocialIdentity(
    providerId: string,
    authProvider: AuthProviderEnum,
  ): Promise<UserAuthRow | null> {
    const sql = `
      SELECT u.id, u.password_hash, u.role, u.account_status, u.deleted_at, u.command_center_id
      FROM user_account u
      INNER JOIN user_identity i ON u.id = i.user_id
      WHERE i.provider_id = $1 
        AND i.provider = $2
        AND i.deleted_at IS NULL
        AND u.deleted_at IS NULL
      LIMIT 1;
    `;

    const { rows } = await this.db.query<UserAuthRow>(sql, [
      providerId,
      authProvider,
    ]);
    return rows[0] || null;
  }

  /**
   * Issues a new activation / reset token, replacing any live one for
   * the same user and purpose, in ONE transaction.
   */
  async replaceAccountActionToken(
    data: CreateActivationTokenData,
  ): Promise<void> {
    const { user_id, purpose, token_hash, expires_at } = data;
    await this.db.withTransaction(async (client) => {
      await client.query(
        `SELECT id FROM user_account WHERE id = $1 FOR UPDATE`,
        [user_id],
      );
      await client.query(
        `DELETE FROM account_action_token
         WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
        [user_id, purpose],
      );
      await client.query(
        `INSERT INTO account_action_token(user_id, purpose, token_hash, expires_at)
         VALUES($1, $2, $3, $4)`,
        [user_id, purpose, token_hash, expires_at],
      );
    });
  }

  /**
   * For the two POST submit endpoints.
   */
  async consumeTokenAndSetPassword(
    tokenHash: string,
    purpose: AccountTokenPurposeEnum,
    passwordHash: string,
  ): Promise<{ user_id: string } | null> {
    return this.db.withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; user_id: string }>(
        `SELECT t.id, t.user_id
         FROM account_action_token t
         JOIN user_account u ON u.id = t.user_id
         WHERE t.token_hash = $1
           AND t.purpose = $2
           AND t.used_at IS NULL
           AND t.expires_at > now()
           AND u.deleted_at IS NULL
           AND (
             (t.purpose = 'activation'     AND u.account_status = 'pending_activation')
             OR (t.purpose = 'password_reset' AND u.account_status = 'active')
           )
         FOR UPDATE OF t`,
        [tokenHash, purpose],
      );
      if (!rows[0]) return null;

      const { id: tokenId, user_id } = rows[0];

      await client.query(
        `UPDATE account_action_token SET used_at = now() WHERE id = $1`,
        [tokenId],
      );
      await client.query(
        `UPDATE user_account
         SET password_hash = $1, account_status = 'active'
         WHERE id = $2`,
        [passwordHash, user_id],
      );
      await client.query(`DELETE FROM user_session WHERE user_id = $1`, [
        user_id,
      ]);

      if (purpose === AccountTokenPurposeEnum.ACTIVATION) {
        await client.query(
          `INSERT INTO system_audit_log(actor_id, action, target_entity, target_id)
           VALUES ($1, 'ACTIVATE_ACCOUNT', 'user_account', $1)`,
          [user_id],
        );
      }

      return { user_id };
    });
  }

  /**
   * Atomically rotates a refresh session.
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
  async updateIdentityLastSignIn(
    userId: string,
    provider: AuthProviderEnum,
    providerId: string,
  ): Promise<void> {
    const sql = `
    UPDATE user_identity
    SET last_sign_in_at = NOW()
    WHERE user_id = $1 AND provider = $2 AND provider_id = $3 AND deleted_at IS NULL;
  `;
    await this.db.query(sql, [userId, provider, providerId]);
  }

  // auth.repository.ts

  /**
   * Inserts a new identity record linked to an existing user.
   */
  // auth.repository.ts
  async linkUserIdentity(
    userId: string,
    provider: AuthProviderEnum,
    providerId: string,
    providerEmail: string,
  ): Promise<void> {
    const sql = `
    INSERT INTO user_identity (user_id, provider, provider_id, provider_email)
    VALUES ($1, $2, $3, $4);
  `;
    await this.db.query(sql, [userId, provider, providerId, providerEmail]);
  }
  /**
   * Soft-deletes a linked social identity for a user.
   */
  async unlinkUserIdentity(
    userId: string,
    provider: AuthProviderEnum,
  ): Promise<boolean> {
    const sql = `
    UPDATE user_identity
    SET deleted_at = NOW()
    WHERE user_id = $1 AND provider = $2 AND deleted_at IS NULL;
  `;
    const { rowCount } = await this.db.query(sql, [userId, provider]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Checks authentication methods for account lockout prevention.
   */
  async getUserAuthSummary(userId: string): Promise<{
    hasPassword: boolean;
    linkedProvidersCount: number;
  }> {
    const sql = `
    SELECT 
      (u.password_hash IS NOT NULL) AS "hasPassword",
      COUNT(i.id)::int AS "linkedProvidersCount"
    FROM user_account u
    LEFT JOIN user_identity i ON u.id = i.user_id AND i.deleted_at IS NULL
    WHERE u.id = $1 AND u.deleted_at IS NULL
    GROUP BY u.id;
  `;
    const { rows } = await this.db.query<{
      hasPassword: boolean;
      linkedProvidersCount: number;
    }>(sql, [userId]);

    return rows[0] ?? { hasPassword: false, linkedProvidersCount: 0 };
  }

  async updatePassword(data: UpdatePasswordData): Promise<boolean> {
    const { id, new_password } = data;

    const sql = 'UPDATE user_account SET password_hash = $1 WHERE id = $2';

    const result = await this.db.query(sql, [new_password, id]);

    return result.rowCount === 1;
  }

  async getPassword(id: string): Promise<PasswordType> {
    const sql = 'SELECT password_hash FROM user_account WHERE id = $1';

    const result = await this.db.query<PasswordType>(sql, [id]);

    return result.rows[0];
  }
}
