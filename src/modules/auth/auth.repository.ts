import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { UserAuthRow } from './interfaces/user-auth-row.interface';
import { Role } from '../../common/enums/role-enum';
import { ActivationStateRow } from './interfaces/activation-state-row.interface';
import { CreateActivationTokenData } from './types/create-activation-token.types';
import { AccountTokenPurposeEnum } from './enums/account-token-purpose.enum';
import { AuthProviderEnum } from '../responders/enums/auth-provider.enum';

@Injectable()
export class AuthRepository {
  constructor(private readonly db: DatabaseService) {}

  async findUserByEmail(email: string): Promise<UserAuthRow | null> {
    // account_status is selected so login can reject pending_activation
    // accounts (which have a NULL password_hash) before comparing.
    const sql = `
      SELECT id, password_hash, role, account_status, deleted_at, command_center_id
      FROM user_account 
      WHERE email = $1
      LIMIT 1;
    `;

    const { rows } = await this.db.query<UserAuthRow>(sql, [email]);
    return rows[0] || null;
  }

  async findUserById(id: string): Promise<UserAuthRow | null> {
    const sql = `
    SELECT id, email, password_hash, role, account_status, deleted_at, command_center_id
    FROM user_account
    WHERE id = $1
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
   *
   * @param tokenHash SHA-256 hash of the raw token from the link.
   * @param purpose Which flow is asking; a token minted for the other
   *   purpose will not match.
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

  async findUserBySocialIdentity(
    providerId: string,
    authProvider: AuthProviderEnum,
  ): Promise<UserAuthRow | null> {
    const sql = `
      SELECT id, password_hash, role, account_status, deleted_at, command_center_id
      FROM user_account 
      WHERE provider_id = $1 AND auth_provider = $2
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
   *
   * - Locking the user row first serializes concurrent "resend" requests
   *   so they can't race into `uq_account_action_token_live_per_purpose`.
   * - Superseded tokens are deleted rather than stamped `used_at`, so
   *   `used_at` only ever means "consumed by the holder".
   * - Issuing a new token kills the previous link (e.g. after a "resend
   *   email" request) instead of leaving two valid tokens outstanding,
   *   per the migration's app-layer requirement.
   * - Purposes are independent: replacing an `activation` token never
   *   touches a `password_reset` token for the same user, and vice versa.
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
   * For the two POST submit endpoints. Everything that must be true
   * together happens in one transaction: the token is locked and
   * re-validated (so a double-click or replay can't use it twice),
   * marked used, the password is set, the account is active, and all
   * existing sessions are dropped (matters for compromise-response
   * resets). Returns null if the token is no longer valid.
   *
   * password_hash and account_status must change together
   * (chck_auth_requirements); setting 'active' is harmless for resets
   * since those accounts are already active.
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
