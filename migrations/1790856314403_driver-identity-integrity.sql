-- Up Migration
-- 004: identity integrity for self-registered drivers
--
-- Closes three gaps found when cross-checking the driver registration flow
-- (DriverService / DriverRepository) against init + 003:
--
--   1. Name CHECKs depended on the database's LC_CTYPE. [[:alpha:]] only
--      matches ASCII letters under the C locale, so a name like "Peña"
--      that the API accepts would be rejected here.
--   2. Nothing stopped one social identity, or one mobile number, from
--      backing two accounts.
--   3. email was UNIQUE across ALL rows, including soft-deleted ones, so a
--      deleted driver could never register again with the same address;
--      it was also case-sensitive.
--
-- PRE-FLIGHT: steps 2 and 3 fail (by design) if the data already violates
-- them. Run these first; every query should return zero rows.
--
--   SELECT lower(email), count(*) FROM user_account
--     WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1;
--   SELECT m_number, count(*) FROM user_account
--     WHERE m_number IS NOT NULL AND deleted_at IS NULL
--     GROUP BY 1 HAVING count(*) > 1;
--   SELECT auth_provider, provider_id, count(*) FROM user_account
--     WHERE provider_id IS NOT NULL AND deleted_at IS NULL
--     GROUP BY 1, 2 HAVING count(*) > 1;

-- ============================================================
-- 1. LOCALE-INDEPENDENT NAME CHECKS
-- ============================================================
-- Explicit code-point ranges instead of [[:alpha:]]: A-Z, a-z, Latin-1
-- letters (excluding the multiplication and division signs) and Latin
-- Extended-A/B (covers n-tilde, accented vowels, etc.). Whitespace and
-- hyphen are still allowed; digits and punctuation are still rejected.
-- Keep the API-side NAME regex in lockstep with this one.
ALTER TABLE user_account DROP CONSTRAINT chck_f_name_format;
ALTER TABLE user_account DROP CONSTRAINT chck_l_name_format;
ALTER TABLE user_account DROP CONSTRAINT chck_m_name_format;

ALTER TABLE user_account ADD CONSTRAINT chck_f_name_format
    CHECK (f_name ~ '^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\s\-]+$');
ALTER TABLE user_account ADD CONSTRAINT chck_l_name_format
    CHECK (l_name ~ '^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\s\-]+$');
ALTER TABLE user_account ADD CONSTRAINT chck_m_name_format
    CHECK (m_name IS NULL OR m_name ~ '^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\s\-]+$');


-- ============================================================
-- 2. IDENTITY UNIQUENESS (live accounts only)
-- ============================================================
-- One Google/Apple identity -> one account. provider_id is NULL for local
-- accounts, so they are excluded.
CREATE UNIQUE INDEX uq_user_account_provider_identity
    ON user_account (auth_provider, provider_id)
    WHERE provider_id IS NOT NULL AND deleted_at IS NULL;

-- One verified mobile number -> one account.
CREATE UNIQUE INDEX uq_user_account_m_number
    ON user_account (m_number)
    WHERE m_number IS NOT NULL AND deleted_at IS NULL;


-- ============================================================
-- 3. EMAIL: CASE-INSENSITIVE, AND REUSABLE AFTER SOFT DELETE
-- ============================================================
-- The plain UNIQUE constraint is replaced by a partial unique index on
-- lower(email). NOTE: anything using ON CONFLICT (email) must switch to
-- ON CONFLICT (lower(email)) WHERE deleted_at IS NULL, and email lookups
-- should filter deleted_at IS NULL (they almost certainly already do).
ALTER TABLE user_account DROP CONSTRAINT user_account_email_key;

CREATE UNIQUE INDEX uq_user_account_email_lower
    ON user_account (lower(email))
    WHERE deleted_at IS NULL;


-- Down Migration

DROP INDEX IF EXISTS uq_user_account_email_lower;
-- Fails if a soft-deleted account's email was re-registered since 004;
-- resolve those duplicates before rolling back.
ALTER TABLE user_account ADD CONSTRAINT user_account_email_key UNIQUE (email);

DROP INDEX IF EXISTS uq_user_account_m_number;
DROP INDEX IF EXISTS uq_user_account_provider_identity;

ALTER TABLE user_account DROP CONSTRAINT IF EXISTS chck_m_name_format;
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS chck_l_name_format;
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS chck_f_name_format;

ALTER TABLE user_account ADD CONSTRAINT chck_f_name_format
    CHECK (f_name ~ '^[[:alpha:]\s\-]+$');
ALTER TABLE user_account ADD CONSTRAINT chck_l_name_format
    CHECK (l_name ~ '^[[:alpha:]\s\-]+$');
ALTER TABLE user_account ADD CONSTRAINT chck_m_name_format
    CHECK (m_name IS NULL OR m_name ~ '^[[:alpha:]\s\-]+$');