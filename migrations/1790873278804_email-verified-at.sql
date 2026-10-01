-- Up Migration
ALTER TABLE user_account
ADD COLUMN email_verified_at TIMESTAMPTZ NULL;

-- Down Migration
ALTER TABLE user_account
DROP COLUMN IF EXISTS email_verified_at;