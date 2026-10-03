-- Up Migration
-- 006: extract user_identity table for multi-provider authentication
--
-- Decouples authentication provider identities from user_account into a 1:N
-- relation (user_identity). Allows users to link multiple login methods
-- (e.g. Local + Google + Apple) to a single account while preserving soft-delete
-- safety and identity uniqueness.

-- ============================================================
-- 1. CREATE USER_IDENTITY TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS user_identity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    provider auth_provider_enum NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    provider_email VARCHAR(150),
    identity_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_sign_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ DEFAULT NULL
);

CREATE TRIGGER trg_user_identity_updated_at
BEFORE UPDATE ON user_identity
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 2. BACKFILL EXISTING IDENTITIES FROM USER_ACCOUNT
-- ============================================================
INSERT INTO user_identity (user_id, provider, provider_id, provider_email, deleted_at, created_at)
SELECT 
    id AS user_id,
    auth_provider AS provider,
    COALESCE(provider_id, id::text) AS provider_id,
    email AS provider_email,
    deleted_at,
    created_at
FROM user_account;

-- ============================================================
-- 3. UNIQUE & PERFORMANCE INDEXES
-- ============================================================
-- Enforce provider identity uniqueness across live (non-deleted) accounts
CREATE UNIQUE INDEX uq_user_identity_provider_id
    ON user_identity (provider, provider_id)
    WHERE deleted_at IS NULL;

-- Prevent attaching duplicate provider types (e.g. two Google accounts) to one user
CREATE UNIQUE INDEX uq_user_identity_user_provider
    ON user_identity (user_id, provider)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_user_identity_user_id ON user_identity(user_id);

-- ============================================================
-- 4. SOFT-DELETE PROPAGATION TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION sync_user_identity_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE user_identity
        SET deleted_at = NEW.deleted_at
        WHERE user_id = NEW.id AND deleted_at IS NULL;
    ELSIF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
        UPDATE user_identity
        SET deleted_at = NULL
        WHERE user_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_user_identity_soft_delete
AFTER UPDATE ON user_account
FOR EACH ROW
WHEN (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
EXECUTE FUNCTION sync_user_identity_soft_delete();

-- ============================================================
-- 5. REFACTOR USER_ACCOUNT CONSTRAINTS & DROP LEGACY COLUMNS
-- ============================================================
DROP INDEX IF EXISTS uq_user_account_provider_identity;

ALTER TABLE user_account DROP CONSTRAINT chck_auth_requirements;

ALTER TABLE user_account ADD CONSTRAINT chck_auth_requirements CHECK (
    (role IN ('admin', 'responder', 'super')
        AND (
            (account_status = 'pending_activation' AND password_hash IS NULL)
            OR (account_status = 'active' AND password_hash IS NOT NULL)
        ))
    OR
    (role = 'driver' AND account_status = 'active')
);

ALTER TABLE user_account DROP COLUMN auth_provider;
ALTER TABLE user_account DROP COLUMN provider_id;


-- Down Migration

ALTER TABLE user_account ADD COLUMN auth_provider auth_provider_enum DEFAULT 'local';
ALTER TABLE user_account ADD COLUMN provider_id VARCHAR(255);

-- Restore primary identity back to user_account from user_identity
UPDATE user_account u
SET 
    auth_provider = ui.provider,
    provider_id = CASE WHEN ui.provider = 'local' THEN NULL ELSE ui.provider_id END
FROM (
    SELECT DISTINCT ON (user_id) user_id, provider, provider_id
    FROM user_identity
    ORDER BY user_id, created_at ASC
) ui
WHERE ui.user_id = u.id;

ALTER TABLE user_account ALTER COLUMN auth_provider SET NOT NULL;

CREATE UNIQUE INDEX uq_user_account_provider_identity
    ON user_account (auth_provider, provider_id)
    WHERE provider_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE user_account DROP CONSTRAINT chck_auth_requirements;

ALTER TABLE user_account ADD CONSTRAINT chck_auth_requirements CHECK (
    (role IN ('admin', 'responder', 'super')
        AND auth_provider = 'local'
        AND provider_id IS NULL
        AND (
            (account_status = 'pending_activation' AND password_hash IS NULL)
            OR (account_status = 'active' AND password_hash IS NOT NULL)
        ))
    OR
    (role = 'driver'
        AND account_status = 'active'
        AND (
            (auth_provider = 'local' AND password_hash IS NOT NULL)
            OR (auth_provider IN ('google', 'apple') AND provider_id IS NOT NULL)
        ))
);

DROP TRIGGER IF EXISTS trg_sync_user_identity_soft_delete ON user_account;
DROP FUNCTION IF EXISTS sync_user_identity_soft_delete();
DROP TABLE IF EXISTS user_identity CASCADE;