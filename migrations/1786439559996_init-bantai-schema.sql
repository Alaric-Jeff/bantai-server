-- Up Migration

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE user_role AS ENUM ('driver', 'responder', 'admin', 'super');
CREATE TYPE cc_type AS ENUM ('barangay', 'police_station', 'mdrrmo');
CREATE TYPE agency_type AS ENUM ('police', 'barangay_tanod', 'mdrrmo');
CREATE TYPE alert_status AS ENUM ('pending', 'viewing', 'dispatched', 'arrived', 'resolved');
CREATE TYPE alert_type AS ENUM ('threat_blade', 'threat_gun', 'threat_human', 'accident', 'connection_loss');
CREATE TYPE alert_source AS ENUM ('edge_websocket', 'sms_fallback', 'redis_timeout');
CREATE TYPE service_provider AS ENUM ('angkas', 'move_it', 'joyride', 'independent');
CREATE TYPE availability_status AS ENUM ('on_duty', 'off_duty', 'dispatched', 'transit');
CREATE TYPE blood_type_enum AS ENUM ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown');
CREATE TYPE police_rank AS ENUM (
    'PGEN', 'PLTGEN', 'PMGEN', 'PBGEN', 'PCOL', 'PLTCOL',
    'PMAJ', 'PCPT', 'PLT', 'PEMS', 'PCMS', 'PSMS',
    'PMSg', 'PSSg', 'PCpl', 'Pat', 'none'
);
CREATE TYPE device_status AS ENUM ('inventory', 'paired', 'reported_lost', 'decommissioned');
CREATE TYPE audit_action AS ENUM (
    'CREATE_CC', 'CREATE_USER', 'UPDATE_USER', 'CHANGE_ROLE',
    'REGISTER_DEVICE', 'PAIR_DEVICE', 'UNPAIR_DEVICE',
    'ACKNOWLEDGE_ALERT', 'DISPATCH_RESPONDER', 'RESOLVE_ALERT',
    'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_REVOKE_SESSION',
    'PROPOSE_ALERT_OUTCOME', 'REVIEW_ALERT_OUTCOME'
);
CREATE TYPE auth_provider_enum AS ENUM ('local', 'google', 'apple');
CREATE TYPE report_status AS ENUM ('draft', 'submitted', 'under_review', 'approved');
CREATE TYPE arrival_confirmation_method AS ENUM ('gps', 'manual');
CREATE TYPE outcome_enum AS ENUM ('confirmed', 'false_positive', 'unresolved');
CREATE TYPE outcome_proposal_enum AS ENUM ('confirmed', 'false_positive');
CREATE TYPE review_status_enum AS ENUM ('pending', 'approved', 'rejected');

CREATE TYPE dispatch_origin_enum AS ENUM ('self_dispatched', 'admin_dispatched');
CREATE TYPE responder_dispatch_status AS ENUM ('assigned', 'en_route', 'arrived', 'stood_down');

CREATE TYPE peer_response_status AS ENUM ('notified', 'acknowledged', 'verified_true', 'verified_false');


-- 2. CORE TABLES
CREATE TABLE IF NOT EXISTS command_center (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL UNIQUE,
    type cc_type NOT NULL,
    branch VARCHAR(100) NOT NULL,
    location GEOGRAPHY(Point, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chck_cc_name_not_empty CHECK (trim(name) <> '')
);

CREATE TABLE IF NOT EXISTS user_account (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    f_name VARCHAR(50) NOT NULL,
    l_name VARCHAR(50) NOT NULL,
    m_name VARCHAR(50),
    email VARCHAR(150) NOT NULL UNIQUE,
    m_number VARCHAR(15),
    role user_role NOT NULL,
    command_center_id UUID REFERENCES command_center(id) ON DELETE RESTRICT,

    avatar_url TEXT,
    auth_provider auth_provider_enum NOT NULL DEFAULT 'local',
    provider_id VARCHAR(255),
    password_hash VARCHAR(255),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ DEFAULT NULL,

    -- [SENIOR DEV NOTE]: Good constraints here. 
    CONSTRAINT branch_scope_check CHECK (
        (role IN ('admin', 'responder') AND command_center_id IS NOT NULL)
        OR (role IN ('driver', 'super') AND command_center_id IS NULL)
    ),
    CONSTRAINT chck_m_number_format CHECK (m_number IS NULL OR m_number ~ '^\+639\d{9}$'),
    CONSTRAINT chck_f_name_format CHECK (f_name ~ '^[[:alpha:]\s\-]+$'),
    CONSTRAINT chck_l_name_format CHECK (l_name ~ '^[[:alpha:]\s\-]+$'),
    CONSTRAINT chck_m_name_format CHECK (m_name IS NULL OR m_name ~ '^[[:alpha:]\s\-]+$'),
    CONSTRAINT chck_auth_requirements CHECK (
        (role IN ('admin', 'responder', 'super')
            AND auth_provider = 'local'
            AND password_hash IS NOT NULL
            AND provider_id IS NULL)
        OR
        (role = 'driver'
            AND (
                (auth_provider = 'local' AND password_hash IS NOT NULL)
                OR (auth_provider IN ('google', 'apple') AND provider_id IS NOT NULL)
            ))
    )
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_account_updated_at
BEFORE UPDATE ON user_account
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION revoke_sessions_on_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE user_session
        SET is_revoked = true
        WHERE user_id = NEW.id AND is_revoked = false;

        -- [SENIOR DEV NOTE]: This will quietly execute and do nothing if the user is a driver/admin.
        -- That's fine, but just be aware it's an unnecessary table scan for non-responders.
        UPDATE r_profile
        SET availability = 'off_duty'
        WHERE user_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_revoke_sessions_on_soft_delete
AFTER UPDATE ON user_account
FOR EACH ROW
WHEN (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
EXECUTE FUNCTION revoke_sessions_on_soft_delete();


-- 3. PROFILE EXTENSIONS
CREATE TABLE IF NOT EXISTS d_profile (
    user_id UUID PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
    service_provider service_provider NOT NULL DEFAULT 'independent',
    service_id VARCHAR(50),
    plate_number VARCHAR(20),
    blood_type blood_type_enum NOT NULL DEFAULT 'unknown',
    address TEXT,
    date_of_birth DATE,
    emergency_contacts JSONB NOT NULL DEFAULT '[]'::jsonb,

    CONSTRAINT service_id_requires_provider CHECK (
        (service_provider = 'independent' AND service_id IS NULL)
        OR (service_provider != 'independent' AND service_id IS NOT NULL)
    ),
    CONSTRAINT emergency_contacts_is_array CHECK (jsonb_typeof(emergency_contacts) = 'array'),
    CONSTRAINT emergency_contacts_max_three CHECK (jsonb_array_length(emergency_contacts) <= 3)
);

CREATE TABLE IF NOT EXISTS r_profile (
    user_id UUID PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
    agency agency_type NOT NULL,
    call_sign VARCHAR(50),
    rank police_rank NOT NULL DEFAULT 'none',
    availability availability_status NOT NULL DEFAULT 'off_duty',

    last_active_at TIMESTAMPTZ DEFAULT now(),
    last_known_location GEOGRAPHY(Point, 4326),

    CONSTRAINT chck_agency_requirements CHECK (
        (agency = 'police' AND call_sign IS NOT NULL AND rank != 'none') OR
        (agency = 'barangay_tanod') OR
        (agency = 'mdrrmo' AND call_sign IS NOT NULL)
    )
);


-- 4. HARDWARE MANAGEMENT
CREATE TABLE IF NOT EXISTS device (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hardware_serial VARCHAR(100) NOT NULL UNIQUE,
    status device_status NOT NULL DEFAULT 'inventory',
    driver_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
    registered_by UUID REFERENCES user_account(id) ON DELETE SET NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paired_at TIMESTAMPTZ,
    unpaired_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,

    CONSTRAINT chck_device_pairing CHECK (
        (status = 'paired' AND driver_id IS NOT NULL AND paired_at IS NOT NULL AND unpaired_at IS NULL) OR
        (status IN ('inventory', 'decommissioned') AND driver_id IS NULL AND paired_at IS NULL) OR
        (status = 'reported_lost')
    )
);

CREATE TABLE IF NOT EXISTS device_pairing_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    -- [SENIOR DEV NOTE]: Good catch keeping ON DELETE RESTRICT here. We need history.
    driver_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
    paired_by UUID REFERENCES user_account(id) ON DELETE SET NULL,
    paired_at TIMESTAMPTZ NOT NULL,
    unpaired_at TIMESTAMPTZ,
    unpair_reason TEXT,

    CONSTRAINT chck_unpaired_after_paired CHECK (
        unpaired_at IS NULL OR unpaired_at >= paired_at
    )
);


-- 5. STATEFUL AUTHENTICATION & SESSION MANAGEMENT
CREATE TABLE IF NOT EXISTS user_session (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    device_id UUID REFERENCES device(id) ON DELETE SET NULL,
    refresh_token_hash VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    is_revoked BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chck_expires_future CHECK (expires_at > created_at)
);


-- 6. INCIDENT & RESPONSE
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- [CRITICAL FIX]: Changed from CASCADE to RESTRICT. 
    -- You never hard-delete an emergency alert record just because an admin hard-deleted a user. 
    -- If a user must be deleted, their alerts stay. Soft delete is your safety net anyway.
    driver_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
    device_id UUID REFERENCES device(id) ON DELETE SET NULL,
    location GEOGRAPHY(Point, 4326) NOT NULL,
    alert_type alert_type NOT NULL,
    source alert_source NOT NULL DEFAULT 'edge_websocket',
    confidence_level NUMERIC(5,4) NOT NULL,
    snapshot_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    outcome outcome_enum NOT NULL DEFAULT 'unresolved',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT con_level_validation CHECK (confidence_level >= 0 AND confidence_level <= 1),
    CONSTRAINT chck_snapshot_urls_is_array CHECK (jsonb_typeof(snapshot_urls) = 'array')
);

CREATE TABLE IF NOT EXISTS alert_branch_response (
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    command_center_id UUID NOT NULL REFERENCES command_center(id) ON DELETE CASCADE,
    status alert_status NOT NULL DEFAULT 'pending',

    triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    dispatched_at TIMESTAMPTZ,
    arrived_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,

    PRIMARY KEY (alert_id, command_center_id)
);

CREATE TABLE IF NOT EXISTS alert_responder_assignment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL,
    command_center_id UUID NOT NULL,
    responder_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
    status responder_dispatch_status NOT NULL DEFAULT 'assigned',
    
    dispatch_origin dispatch_origin_enum NOT NULL,
    assigned_by UUID REFERENCES user_account(id) ON DELETE SET NULL,

    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    arrived_at TIMESTAMPTZ,
    arrival_confirmation_method arrival_confirmation_method,
    arrived_confirmed_by UUID REFERENCES user_account(id) ON DELETE SET NULL,

    FOREIGN KEY (alert_id, command_center_id)
        REFERENCES alert_branch_response(alert_id, command_center_id)
        ON DELETE CASCADE,

    CONSTRAINT chck_individual_arrival_consistency CHECK (
        (arrived_at IS NULL AND arrival_confirmation_method IS NULL)
        OR (arrived_at IS NOT NULL AND arrival_confirmation_method IS NOT NULL)
    ),
    CONSTRAINT chck_dispatch_origin_logic CHECK (
        (dispatch_origin = 'self_dispatched' AND assigned_by IS NULL)
        OR (dispatch_origin = 'admin_dispatched' AND assigned_by IS NOT NULL)
    )
);

CREATE OR REPLACE FUNCTION promote_branch_status_on_dispatch()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE alert_branch_response
    SET status = 'dispatched', 
        dispatched_at = COALESCE(dispatched_at, now())
    WHERE alert_id = NEW.alert_id
      AND command_center_id = NEW.command_center_id
      AND status IN ('pending', 'viewing');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_promote_branch_status_on_dispatch
AFTER INSERT OR UPDATE ON alert_responder_assignment
FOR EACH ROW
EXECUTE FUNCTION promote_branch_status_on_dispatch();

CREATE OR REPLACE FUNCTION promote_branch_status_on_first_arrival()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.arrived_at IS NOT NULL AND (OLD.arrived_at IS NULL) THEN
        UPDATE alert_branch_response
        SET status = 'arrived', arrived_at = NEW.arrived_at
        WHERE alert_id = NEW.alert_id
          AND command_center_id = NEW.command_center_id
          AND arrived_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_promote_branch_status_on_first_arrival
AFTER UPDATE ON alert_responder_assignment
FOR EACH ROW
WHEN (NEW.arrived_at IS DISTINCT FROM OLD.arrived_at)
EXECUTE FUNCTION promote_branch_status_on_first_arrival();

CREATE TABLE IF NOT EXISTS alert_peer_response (
    id UUID DEFAULT gen_random_uuid(),
    -- [CRITICAL FIX]: Changed ON DELETE CASCADE to RESTRICT.
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
    peer_driver_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
    status peer_response_status NOT NULL DEFAULT 'notified',
    notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    
    PRIMARY KEY (id),
    CONSTRAINT uq_alert_peer UNIQUE (alert_id, peer_driver_id)
);


-- 7. ALERT OUTCOME REVIEW
CREATE TABLE IF NOT EXISTS alert_outcome_review (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- [CRITICAL FIX]: Changed CASCADE to RESTRICT. 
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
    proposed_by UUID NOT NULL REFERENCES user_account(id),
    proposed_outcome outcome_proposal_enum NOT NULL,
    evidence_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence_location GEOGRAPHY(Point, 4326),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    reviewed_by UUID REFERENCES user_account(id),
    review_status review_status_enum NOT NULL DEFAULT 'pending',
    review_notes TEXT,
    reviewed_at TIMESTAMPTZ,

    CONSTRAINT chck_evidence_urls_is_array CHECK (jsonb_typeof(evidence_urls) = 'array'),
    CONSTRAINT chck_review_consistency CHECK (
        (review_status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (review_status != 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
    CONSTRAINT chck_reviewer_not_proposer CHECK (
        reviewed_by IS NULL OR reviewed_by != proposed_by
    )
);


-- 8. POST-INCIDENT REPORTING
CREATE TABLE IF NOT EXISTS incident_report (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- [CRITICAL FIX]: Changed CASCADE to RESTRICT. 
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
    command_center_id UUID NOT NULL REFERENCES command_center(id) ON DELETE RESTRICT,

    assigned_reporter_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
    submitted_by_id UUID REFERENCES user_account(id) ON DELETE SET NULL,

    summary TEXT NOT NULL,
    detailed_narrative TEXT,
    evidence_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    status report_status NOT NULL DEFAULT 'draft',

    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chck_evidence_urls_array CHECK (jsonb_typeof(evidence_urls) = 'array')
);

CREATE TRIGGER trg_incident_report_updated_at
BEFORE UPDATE ON incident_report
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- 9. SYSTEM AUDIT LOGGING (Partitioned by Range)
CREATE TABLE IF NOT EXISTS system_audit_log (
    id UUID DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
    command_center_id UUID REFERENCES command_center(id) ON DELETE SET NULL,
    action audit_action NOT NULL,
    target_entity VARCHAR(50) NOT NULL,
    target_id UUID NOT NULL,
    old_payload JSONB,
    new_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- [SENIOR DEV NOTE]: The default partition is a catch-all. 
-- If you don't create specific month/year partitions, EVERYTHING goes here, defeating the purpose of partitioning.
-- I've added a partition for this current month (Aug 2026) as an example.
-- You will need a cron job (using NestJS task scheduling) or `pg_partman` to automate future partitions.
CREATE TABLE system_audit_log_y2026m08 PARTITION OF system_audit_log 
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE TABLE system_audit_log_default PARTITION OF system_audit_log DEFAULT;


-- 10. DASHBOARD VIEWS
CREATE OR REPLACE VIEW branch_incident_logs AS
SELECT
    a.id AS alert_id,
    abr.command_center_id,
    a.alert_type,
    a.source AS alert_source,
    a.confidence_level,
    a.outcome,
    abr.status,
    u.id AS driver_id,
    u.f_name || ' ' || u.l_name AS rider_name,
    u.deleted_at AS rider_deleted_at,
    d.hardware_serial,
    abr.triggered_at,
    abr.acknowledged_at,
    abr.dispatched_at,
    abr.arrived_at,
    abr.resolved_at,
    EXTRACT(EPOCH FROM (abr.acknowledged_at - abr.triggered_at)) AS reaction_time_seconds
FROM alerts a
JOIN alert_branch_response abr ON a.id = abr.alert_id
JOIN user_account u ON a.driver_id = u.id
LEFT JOIN device d ON a.device_id = d.id;


-- 11. DIAGNOSTIC VIEWS
CREATE OR REPLACE VIEW v_index_performance AS
SELECT
    sui.schemaname,
    sui.relname AS table_name,
    sui.indexrelname AS index_name,
    pg_size_pretty(pg_relation_size(sui.indexrelid)) AS index_size,
    sui.idx_scan AS total_index_scans,
    sui.idx_tup_read AS tuples_read_from_index,
    sui.idx_tup_fetch AS tuples_fetched_from_table,
    (sut.n_tup_ins + sut.n_tup_upd + sut.n_tup_del) AS total_table_writes,
    CASE
        WHEN i.indisprimary THEN 'PRIMARY_KEY'
        WHEN i.indisunique THEN 'UNIQUE_CONSTRAINT'
        WHEN sui.idx_scan = 0 THEN 'UNUSED'
        WHEN (sut.n_tup_ins + sut.n_tup_upd + sut.n_tup_del) > 1000
             AND sui.idx_scan < 50 THEN 'HIGH_WRITE_LOW_READ'
        ELSE 'ACTIVE'
    END AS assessment_code
FROM pg_stat_user_indexes sui
JOIN pg_stat_user_tables sut ON sui.relid = sut.relid
JOIN pg_index i ON sui.indexrelid = i.indexrelid;

CREATE OR REPLACE VIEW v_table_index_usage AS
SELECT
    relname AS table_name,
    seq_scan AS sequential_scans,
    idx_scan AS index_scans,
    n_tup_ins + n_tup_upd + n_tup_del AS total_writes,
    ROUND(
        100.0 * idx_scan / NULLIF(seq_scan + idx_scan, 0), 2
    ) AS index_usage_percentage
FROM pg_stat_user_tables;


-- 12. PERFORMANCE INDEXES
CREATE INDEX idx_command_center_location ON command_center USING GIST (location);
CREATE INDEX idx_alerts_location ON alerts USING GIST (location);

CREATE INDEX idx_user_account_cc_id ON user_account(command_center_id);
CREATE INDEX idx_device_driver_id ON device(driver_id);
CREATE INDEX idx_device_hardware_serial ON device(hardware_serial);
CREATE INDEX idx_alerts_driver_id ON alerts(driver_id);

CREATE INDEX idx_ara_responder ON alert_responder_assignment(responder_id);
CREATE INDEX idx_ara_branch_alert ON alert_responder_assignment(alert_id, command_center_id);

CREATE INDEX idx_abr_command_center ON alert_branch_response(command_center_id);

CREATE INDEX idx_apr_peer ON alert_peer_response(peer_driver_id);
CREATE INDEX idx_apr_alert ON alert_peer_response(alert_id, status);

CREATE INDEX idx_audit_cc_id ON system_audit_log(command_center_id);

CREATE INDEX idx_user_session_token ON user_session(refresh_token_hash);
CREATE INDEX idx_user_session_user_id ON user_session(user_id) WHERE is_revoked = false;
CREATE INDEX idx_user_session_expires_at ON user_session(expires_at);

CREATE INDEX idx_r_profile_location ON r_profile USING GIST (last_known_location);
CREATE INDEX idx_r_profile_availability ON r_profile(availability, last_active_at);

CREATE INDEX idx_user_account_deleted_at ON user_account(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX idx_incident_report_alert ON incident_report(alert_id);
CREATE INDEX idx_incident_report_cc ON incident_report(command_center_id);
CREATE INDEX idx_incident_report_assignee ON incident_report(assigned_reporter_id);

CREATE INDEX idx_device_pairing_history_device ON device_pairing_history(device_id);
CREATE INDEX idx_device_pairing_history_driver ON device_pairing_history(driver_id);

CREATE INDEX idx_alert_outcome_review_alert ON alert_outcome_review(alert_id);
CREATE INDEX idx_alert_outcome_review_pending ON alert_outcome_review(review_status) WHERE review_status = 'pending';


-- Down Migration

DROP VIEW IF EXISTS v_table_index_usage;
DROP VIEW IF EXISTS v_index_performance;
DROP VIEW IF EXISTS branch_incident_logs;

-- [SENIOR DEV NOTE]: Ensure partitions are dropped by cascading the parent.
DROP TABLE IF EXISTS system_audit_log CASCADE;
DROP TABLE IF EXISTS incident_report CASCADE;
DROP TABLE IF EXISTS alert_outcome_review CASCADE;
DROP TABLE IF EXISTS alert_responder_assignment CASCADE;
DROP TABLE IF EXISTS alert_branch_response CASCADE;
DROP TABLE IF EXISTS alert_peer_response CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS user_session CASCADE;
DROP TABLE IF EXISTS device_pairing_history CASCADE;
DROP TABLE IF EXISTS device CASCADE;
DROP TABLE IF EXISTS r_profile CASCADE;
DROP TABLE IF EXISTS d_profile CASCADE;
DROP TABLE IF EXISTS user_account CASCADE;
DROP TABLE IF EXISTS command_center CASCADE;

DROP FUNCTION IF EXISTS promote_branch_status_on_dispatch();
DROP FUNCTION IF EXISTS promote_branch_status_on_first_arrival();
DROP FUNCTION IF EXISTS revoke_sessions_on_soft_delete();
DROP FUNCTION IF EXISTS set_updated_at();

DROP TYPE IF EXISTS peer_response_status;
DROP TYPE IF EXISTS dispatch_origin_enum;
DROP TYPE IF EXISTS responder_dispatch_status;
DROP TYPE IF EXISTS review_status_enum;
DROP TYPE IF EXISTS outcome_proposal_enum;
DROP TYPE IF EXISTS outcome_enum;
DROP TYPE IF EXISTS arrival_confirmation_method;
DROP TYPE IF EXISTS report_status;
DROP TYPE IF EXISTS auth_provider_enum;
DROP TYPE IF EXISTS audit_action;
DROP TYPE IF EXISTS device_status;
DROP TYPE IF EXISTS police_rank;
DROP TYPE IF EXISTS blood_type_enum;
DROP TYPE IF EXISTS service_provider;
DROP TYPE IF EXISTS alert_source;
DROP TYPE IF EXISTS alert_type;
DROP TYPE IF EXISTS alert_status;
DROP TYPE IF EXISTS agency_type;
DROP TYPE IF EXISTS cc_type;
DROP TYPE IF EXISTS user_role;
DROP TYPE IF EXISTS availability_status;