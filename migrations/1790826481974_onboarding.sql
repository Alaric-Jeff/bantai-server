-- Up Migration
-- 003: driver onboarding fields
--
-- Backs the Flutter driver app's 6-step registration wizard
-- (personal details -> account & login -> license & operator ->
-- vehicle & medical -> face enrollment -> phone verification).
--
-- DELIBERATELY NOT ADDED HERE:
--   * Anything for face enrollment. The wizard's own copy says the
--     face map is stored ON-DEVICE and used to confirm identity
--     locally before an SOS cancellation — it never reaches the
--     server, so there is nothing for Postgres to hold.
--   * A phone-OTP challenge table. The 6-digit code is ephemeral,
--     high-volume (abandoned signups), and worthless once consumed or
--     expired — the same profile as the incident-dispatch wave
--     offers, which this schema already keeps in Redis rather than
--     Postgres. Only the FACT that a number was verified, and when,
--     is worth persisting (user_account.phone_verified_at below).
--
-- ARCHITECTURAL PRECONDITION this migration assumes (enforced at the
-- app layer, in DriverRepository): a driver row is created in ONE
-- transactional INSERT once the entire wizard is complete — never
-- progressively. This isn't a style preference; chck_auth_requirements
-- already forces role='driver' rows to be account_status='active' with
-- no 'pending_activation' escape hatch, and f_name/l_name are NOT NULL
-- with a format CHECK that rejects empty strings. A driver row
-- literally cannot be INSERTed in a partial state — the schema was
-- already built assuming drivers arrive complete, so the columns added
-- here follow that same discipline: NOT NULL wherever the wizard
-- screen shows no "Optional" label, matching what already exists on
-- this table (blood_type, emergency_contacts, etc).

-- ============================================================
-- 1. PHONE VERIFICATION STAMP (user_account)
-- ============================================================
-- Nullable by design, not just at creation: if a driver ever changes
-- their mobile number later, the app layer must null this out again
-- until the NEW number is re-verified via OTP. It is not tied to
-- account_status the way password_hash is, because re-verification
-- doesn't suspend the account — it's a trust signal, not a gate.
ALTER TABLE user_account ADD COLUMN phone_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN user_account.phone_verified_at IS
    'Set by the app layer the moment the OTP challenge for m_number is consumed successfully. Reset to NULL by the app layer whenever m_number changes, until the new number is re-verified.';


-- ============================================================
-- 2. LICENSE & OPERATOR (d_profile) — wizard screen 3
-- ============================================================
ALTER TABLE d_profile ADD COLUMN license_number VARCHAR(50);
ALTER TABLE d_profile ADD COLUMN license_expires_at DATE;
ALTER TABLE d_profile ADD COLUMN years_riding SMALLINT;

-- Distinct from the existing service_id column. service_id is a
-- ride-hailing PLATFORM's own driver id (required for angkas/move_it/
-- joyride, forbidden for independent — see service_id_requires_provider
-- below). fleet_operator_id is the opposite case: an optional TODA or
-- fleet affiliation, most relevant for INDEPENDENT riders, with no
-- cross-field requirement tying it to service_provider at all.
ALTER TABLE d_profile ADD COLUMN fleet_operator_id VARCHAR(50);

ALTER TABLE d_profile ADD CONSTRAINT chck_years_riding_nonneg
    CHECK (years_riding IS NULL OR years_riding >= 0);

-- No format CHECK on license_number: LTO license number formatting
-- isn't something to hard-code a regex against without an authoritative
-- spec — getting it wrong would block real drivers outright. Validate
-- shape (if at all) at the DTO layer, where a bad guess is a warning,
-- not a wall.


-- ============================================================
-- 3. VEHICLE DETAILS (d_profile) — wizard screen 4
-- ============================================================
ALTER TABLE d_profile ADD COLUMN vehicle_model VARCHAR(100);
ALTER TABLE d_profile ADD COLUMN vehicle_color VARCHAR(50);


-- ============================================================
-- 4. MEDICAL (d_profile) — wizard screen 4
-- ============================================================
-- Free text on purpose, same reasoning as incident.detected_class:
-- the set of things worth recording here ("none", "asthma",
-- "allergic to penicillin, type 1 diabetic") doesn't fit a fixed enum
-- and responders need to read it as-is during an SOS, not decode a
-- category id.
ALTER TABLE d_profile ADD COLUMN medical_conditions TEXT;


-- ============================================================
-- 5. DATA-SHARING CONSENT (d_profile) — wizard screen 4 checkbox
-- ============================================================
-- The wizard gates registration on an explicit consent checkbox
-- ("I allow B.A.N.T.A.I to share my location, plate, blood type, and
-- medical notes..."). Recorded as a timestamp rather than a boolean
-- so there's a real answer to "when did this driver actually agree to
-- this" if that's ever needed for a compliance question, not just
-- whether they currently have it checked.
ALTER TABLE d_profile ADD COLUMN data_sharing_consented_at TIMESTAMPTZ;


-- ============================================================
-- 6. LOCK DOWN THE NOW-REQUIRED COLUMNS
-- ============================================================
-- Split from the ADD COLUMN statements above on purpose: an ALTER
-- TABLE ... ADD COLUMN ... NOT NULL with no DEFAULT fails outright on
-- a table that already has rows, whereas adding nullable first and
-- enforcing NOT NULL as a second step only fails on rows that are
-- ALREADY missing the data — which is exactly the signal you'd want
-- surfaced (existing incomplete driver rows, if any, need a real
-- backfill decision, not a silently-accepted migration).
ALTER TABLE d_profile ALTER COLUMN license_number SET NOT NULL;
ALTER TABLE d_profile ALTER COLUMN license_expires_at SET NOT NULL;
ALTER TABLE d_profile ALTER COLUMN years_riding SET NOT NULL;
ALTER TABLE d_profile ALTER COLUMN vehicle_model SET NOT NULL;
ALTER TABLE d_profile ALTER COLUMN vehicle_color SET NOT NULL;
ALTER TABLE d_profile ALTER COLUMN medical_conditions SET NOT NULL;
ALTER TABLE d_profile ALTER COLUMN data_sharing_consented_at SET NOT NULL;

-- fleet_operator_id stays nullable — explicitly marked "Optional" on
-- the wizard screen itself (step 3: "Optional — TODA or fleet").
-- phone_verified_at stays nullable — see the comment on it above.


-- Down Migration

ALTER TABLE d_profile DROP COLUMN IF EXISTS data_sharing_consented_at;
ALTER TABLE d_profile DROP COLUMN IF EXISTS medical_conditions;
ALTER TABLE d_profile DROP COLUMN IF EXISTS vehicle_color;
ALTER TABLE d_profile DROP COLUMN IF EXISTS vehicle_model;

ALTER TABLE d_profile DROP CONSTRAINT IF EXISTS chck_years_riding_nonneg;
ALTER TABLE d_profile DROP COLUMN IF EXISTS fleet_operator_id;
ALTER TABLE d_profile DROP COLUMN IF EXISTS years_riding;
ALTER TABLE d_profile DROP COLUMN IF EXISTS license_expires_at;
ALTER TABLE d_profile DROP COLUMN IF EXISTS license_number;

ALTER TABLE user_account DROP COLUMN IF EXISTS phone_verified_at;