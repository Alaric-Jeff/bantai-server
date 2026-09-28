-- Up Migration
-- init (autonomous wave-dispatch architecture)
--
-- Architecture summary (what this schema now models):
--   * Incidents are detected at the edge (YOLO) or raised via manual SOS
--     and are processed instantly in Redis. Postgres is the durable
--     record and the referee of last resort — it must reflect every
--     state lock the Redis layer decides.
--   * A spatial engine issues radial WAVES (1-3 km) directly to nearby
--     peer drivers and on-duty responders. Many responders are OFFERED
--     the incident; exactly ONE wins the claim (atomic Lua script in
--     Redis, mirrored here by a partial unique index so the database
--     itself can never hold two active claimants).
--   * Command centers are NOT initial routers anymore. They provision
--     accounts, own incident-report paperwork, passively monitor, and
--     are ESCALATION TARGETS when an incident hits an SLA timeout or
--     needs manual intervention.
--   * Operational resolution / scene safety is a separate concern from
--     paperwork review. threat_category + threat_level decide whether a
--     responder may close an incident autonomously or must send it
--     through verification.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================
-- 1. ENUMS
-- ============================================================
CREATE TYPE user_role AS ENUM ('driver', 'responder', 'admin', 'super');
CREATE TYPE cc_type AS ENUM ('barangay', 'police_station', 'mdrrmo');
CREATE TYPE agency_type AS ENUM ('police', 'barangay_tanod', 'mdrrmo');
CREATE TYPE service_provider AS ENUM ('angkas', 'move_it', 'joyride', 'independent');
CREATE TYPE availability_status AS ENUM ('on_duty', 'off_duty', 'dispatched', 'en_route');
CREATE TYPE blood_type_enum AS ENUM ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown');
CREATE TYPE police_rank AS ENUM (
    'PGEN', 'PLTGEN', 'PMGEN', 'PBGEN', 'PCOL', 'PLTCOL',
    'PMAJ', 'PCPT', 'PLT', 'PEMS', 'PCMS', 'PSMS',
    'PMSg', 'PSSg', 'PCpl', 'Pat', 'none'
);
CREATE TYPE device_status AS ENUM ('inventory', 'paired', 'reported_lost', 'decommissioned'); -- deprecated
CREATE TYPE auth_provider_enum AS ENUM ('local', 'google', 'apple');
CREATE TYPE report_status AS ENUM ('draft', 'submitted', 'under_review', 'needs_revision', 'approved');
CREATE TYPE arrival_confirmation_method AS ENUM ('gps', 'manual');
CREATE TYPE outcome_enum AS ENUM ('confirmed', 'false_positive', 'unresolved');

-- REMOVED (legacy central-gatekeeper model): alert_status, alert_type,
-- alert_source, dispatch_origin_enum, responder_dispatch_status.
--   alert_status          -> incident_status_enum
--   alert_type            -> threat_category_enum (+ detected_class text)
--   alert_source          -> trigger_source_enum
--   dispatch_origin_enum  -> assignment_origin_enum
--   responder_dispatch_.. -> assignment_status_enum

-- Lifecycle of an incident. 'CLAIMED' is the state lock: it is the
-- moment one responder wins the race and every other offer is void.
CREATE TYPE incident_status_enum AS ENUM (
    'DETECTED',
    'DISPATCHING',
    'CLAIMED',
    'EN_ROUTE',
    'ON_SCENE',
    'AWAITING_VERIFICATION',
    'ESCALATED',
    'RESOLVED',
    'CANCELLED'
);

-- Static classification made at detection time. Governs closure rules:
--   ASSIST         no adversarial threat (crash, breakdown, medical) —
--                  the responder may close it autonomously.
--   DE_ESCALATABLE a confrontation that can be defused — autonomous
--                  closure only once the scene is DE_ESCALATED / CLEAR.
--   HAZARD         armed / serious threat — NEVER closable autonomously;
--                  must be verified by someone other than the claimant.
CREATE TYPE threat_category_enum AS ENUM ('ASSIST', 'DE_ESCALATABLE', 'HAZARD');

-- Live scene-safety state, updated as responders report from the scene.
CREATE TYPE threat_level_enum AS ENUM ('ACTIVE_THREAT', 'DE_ESCALATED', 'CLEAR');

CREATE TYPE trigger_source_enum AS ENUM ('EDGE_AI', 'MANUAL_SOS', 'CENTER_MANUAL');

CREATE TYPE escalation_reason_enum AS ENUM ('SLA_TIMEOUT', 'MANUAL_INTERVENTION');

-- Who put a responder on an incident: the wave engine (they were one of
-- many offered) or a command center that took over an escalation.
CREATE TYPE assignment_origin_enum AS ENUM ('WAVE_OFFER', 'CENTER_ASSIGNED');

-- Per-responder view of an incident. OFFERED -> {DECLINED, EXPIRED,
-- LOST_RACE, CLAIMED}; the single CLAIMED responder then walks
-- EN_ROUTE -> ARRIVED, or drops out via STOOD_DOWN.
CREATE TYPE assignment_status_enum AS ENUM (
    'OFFERED',
    'DECLINED',
    'EXPIRED',
    'LOST_RACE',
    'CLAIMED',
    'EN_ROUTE',
    'ARRIVED',
    'STOOD_DOWN'
);

-- Peers can acknowledge and optionally offer help; they can NEVER
-- verify or discredit an incident — no verdict values here, ever.
CREATE TYPE peer_response_status AS ENUM ('notified', 'acknowledged', 'en_route', 'on_scene', 'stood_down');

-- Structured disposition tags for a post-incident report. Paperwork
-- only: the report no longer resolves the incident or decides its
-- outcome — operational closure is governed by incident.status and the
-- threat/verification rules on the incident itself.
CREATE TYPE incident_disposition_enum AS ENUM (
    'treated_on_scene_refused_transport',
    'scene_secured_by_police',
    'vehicle_towed_traffic_cleared',
    'handled_by_barangay',
    'false_alarm'
);

-- Responder mobile app inbox (durable events only — live wave offers
-- travel over Redis/push, not through this table).
CREATE TYPE notification_type_enum AS ENUM (
    'dispatch_assigned',
    'report_review_result',
    'incident_resolved',
    'incident_escalated',
    'shift_ending_soon',
    'shift_auto_ended'
);

-- Rendering hint only — lets the UI style a notification correctly
-- without fragile text-parsing of the title/body.
CREATE TYPE notification_tone_enum AS ENUM ('success', 'attention', 'info');

-- Provisioning/authentication lifecycle for admin/responder/super
-- accounts. A provisioned account has NO password at all until the
-- holder activates it via a single-use token — there is no temporary
-- secret ever created or emailed.
CREATE TYPE account_status_enum AS ENUM ('pending_activation', 'active');

-- Same token mechanism doubles as the path for an admin-forced
-- password reset on an already-active account (compromise response).
CREATE TYPE account_token_purpose_enum AS ENUM ('activation', 'password_reset');

CREATE TYPE audit_action AS ENUM (
    'CREATE_CC', 'CREATE_USER', 'UPDATE_USER', 'CHANGE_ROLE',
    'PAIR_DEVICE', 'UNPAIR_DEVICE',
    'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_REVOKE_SESSION', 'ACTIVATE_ACCOUNT',
    'CREATE_INCIDENT', 'CLAIM_INCIDENT', 'RELEASE_INCIDENT_CLAIM',
    'ASSIGN_RESPONDER', 'CHANGE_THREAT_LEVEL', 'ESCALATE_INCIDENT',
    'VERIFY_INCIDENT', 'RESOLVE_INCIDENT', 'CANCEL_INCIDENT',
    'SUBMIT_INCIDENT_REPORT', 'REVIEW_INCIDENT_REPORT'
);


-- ============================================================
-- 2. CORE TABLES
-- ============================================================
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
    account_status account_status_enum NOT NULL DEFAULT 'active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ DEFAULT NULL,

    CONSTRAINT branch_scope_check CHECK (
        (role IN ('admin', 'responder') AND command_center_id IS NOT NULL)
        OR (role IN ('driver', 'super') AND command_center_id IS NULL)
    ),
    CONSTRAINT chck_m_number_format CHECK (m_number IS NULL OR m_number ~ '^\+639\d{9}$'),
    CONSTRAINT chck_f_name_format CHECK (f_name ~ '^[[:alpha:]\s\-]+$'),
    CONSTRAINT chck_l_name_format CHECK (l_name ~ '^[[:alpha:]\s\-]+$'),
    CONSTRAINT chck_m_name_format CHECK (m_name IS NULL OR m_name ~ '^[[:alpha:]\s\-]+$'),
    -- A pending_activation account is REQUIRED to have no password yet,
    -- and an active one is REQUIRED to have one. Drivers self-register
    -- and are never provisioned by an admin, so they're never in
    -- pending_activation at all.
    CONSTRAINT chck_auth_requirements CHECK (
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

-- Optional audit-attribution hook. Triggers cannot see the application
-- user, so the API may run  SET LOCAL app.current_user_id = '<uuid>'
-- inside a transaction; audit rows written by triggers then carry that
-- actor. When it is unset (the wave engine, the SLA sweeper), the
-- trigger falls back to a column on the row, or NULL — which by
-- convention means "the system did this".
CREATE OR REPLACE FUNCTION current_app_user_id()
RETURNS UUID AS $$
DECLARE
    v_raw TEXT;
BEGIN
    v_raw := current_setting('app.current_user_id', true);
    IF v_raw IS NULL OR v_raw = '' THEN
        RETURN NULL;
    END IF;
    RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;


-- ============================================================
-- 3. PROFILE EXTENSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS d_profile (
    user_id UUID PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
    service_provider service_provider NOT NULL DEFAULT 'independent',
    service_id VARCHAR(50),
    plate_number VARCHAR(20),
    blood_type blood_type_enum NOT NULL DEFAULT 'unknown',
    address TEXT,
    date_of_birth DATE,
    emergency_contacts JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT service_id_requires_provider CHECK (
        (service_provider = 'independent' AND service_id IS NULL)
        OR (service_provider != 'independent' AND service_id IS NOT NULL)
    ),
    CONSTRAINT emergency_contacts_is_array CHECK (jsonb_typeof(emergency_contacts) = 'array'),
    CONSTRAINT emergency_contacts_max_three CHECK (jsonb_array_length(emergency_contacts) <= 3)
);

CREATE TRIGGER trg_d_profile_updated_at
BEFORE UPDATE ON d_profile
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS r_profile (
    user_id UUID PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
    agency agency_type NOT NULL,
    call_sign VARCHAR(50),
    rank police_rank NOT NULL DEFAULT 'none',
    availability availability_status NOT NULL DEFAULT 'off_duty',

    last_active_at TIMESTAMPTZ DEFAULT now(),
    last_known_location GEOGRAPHY(Point, 4326),

    unit VARCHAR(50),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chck_agency_requirements CHECK (
        (agency = 'police' AND call_sign IS NOT NULL AND rank != 'none') OR
        (agency = 'barangay_tanod') OR
        (agency = 'mdrrmo' AND call_sign IS NOT NULL)
    )
);

CREATE TRIGGER trg_r_profile_updated_at
BEFORE UPDATE ON r_profile
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 4. HARDWARE MANAGEMENT
-- ============================================================
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
    driver_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
    paired_by UUID REFERENCES user_account(id) ON DELETE SET NULL,
    paired_at TIMESTAMPTZ NOT NULL,
    unpaired_at TIMESTAMPTZ,
    unpair_reason TEXT,

    CONSTRAINT chck_unpaired_after_paired CHECK (
        unpaired_at IS NULL OR unpaired_at >= paired_at
    )
);


-- ============================================================
-- 5. STATEFUL AUTHENTICATION & SESSION MANAGEMENT
-- ============================================================
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

-- Backs account activation (pending_activation -> active) and
-- admin-forced password resets on already-active accounts.
CREATE TABLE IF NOT EXISTS account_action_token (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    purpose account_token_purpose_enum NOT NULL,

    -- Never store the raw token, only its hash — identical discipline
    -- to refresh_token_hash on user_session.
    token_hash VARCHAR(255) NOT NULL UNIQUE,

    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chck_token_expires_future CHECK (expires_at > created_at)
);

CREATE INDEX idx_account_action_token_hash
    ON account_action_token(token_hash) WHERE used_at IS NULL;

CREATE INDEX idx_account_action_token_user
    ON account_action_token(user_id);

-- At most one live (unused) token per person per purpose. Issuing a
-- second link must invalidate/replace the first (app-layer duty).
CREATE UNIQUE INDEX uq_account_action_token_live_per_purpose
    ON account_action_token(user_id, purpose) WHERE used_at IS NULL;

-- APP-LAYER REQUIREMENT (depends on user_account.account_status, a
-- different table, so not a plain CHECK): an 'activation' token must
-- only be created for a pending_activation account, and a
-- 'password_reset' token only for an already-active account.


-- ============================================================
-- 6. INCIDENTS & WAVE DISPATCH
-- ============================================================

-- Legal status moves. Terminal states (RESOLVED, CANCELLED) have no
-- exits. The CLAIMED/EN_ROUTE/ESCALATED -> DISPATCHING edges are the
-- "release the claim and re-wave" paths; DETECTED -> CLAIMED is allowed
-- so a very fast claim can land before the first wave row is written.
CREATE OR REPLACE FUNCTION is_valid_incident_transition(
    p_from incident_status_enum,
    p_to incident_status_enum
) RETURNS BOOLEAN AS $$
    SELECT CASE p_from
        WHEN 'DETECTED' THEN
            p_to IN ('DISPATCHING', 'CLAIMED', 'ESCALATED', 'CANCELLED')
        WHEN 'DISPATCHING' THEN
            p_to IN ('CLAIMED', 'ESCALATED', 'CANCELLED')
        WHEN 'CLAIMED' THEN
            p_to IN ('EN_ROUTE', 'ON_SCENE', 'DISPATCHING', 'ESCALATED', 'CANCELLED')
        WHEN 'EN_ROUTE' THEN
            p_to IN ('ON_SCENE', 'DISPATCHING', 'ESCALATED', 'CANCELLED')
        WHEN 'ON_SCENE' THEN
            p_to IN ('AWAITING_VERIFICATION', 'RESOLVED', 'ESCALATED', 'CANCELLED')
        WHEN 'AWAITING_VERIFICATION' THEN
            p_to IN ('ON_SCENE', 'RESOLVED', 'ESCALATED', 'CANCELLED')
        WHEN 'ESCALATED' THEN
            p_to IN ('DISPATCHING', 'CLAIMED', 'EN_ROUTE', 'ON_SCENE',
                     'AWAITING_VERIFICATION', 'RESOLVED', 'CANCELLED')
        ELSE FALSE
    END
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS incident (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL only for CENTER_MANUAL incidents (a walk-in / phone report
    -- for someone who is not a registered rider).
    driver_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
    device_id UUID REFERENCES device(id) ON DELETE SET NULL,
    location GEOGRAPHY(Point, 4326) NOT NULL,

    trigger_source trigger_source_enum NOT NULL,
    -- Raw class label from the edge model (e.g. 'blade', 'gun',
    -- 'person', 'collision'). Free text on purpose: the model's label
    -- set changes faster than a schema should.
    detected_class VARCHAR(50),
    -- Model confidence. Required for EDGE_AI, NULL for human-raised.
    confidence_level NUMERIC(5,4),
    snapshot_urls JSONB NOT NULL DEFAULT '[]'::jsonb,

    threat_category threat_category_enum NOT NULL,
    -- Conservative default: assume danger until a responder on scene
    -- says otherwise. The dispatch engine should set 'CLEAR' up front
    -- for ASSIST incidents.
    threat_level threat_level_enum NOT NULL DEFAULT 'ACTIVE_THREAT',
    status incident_status_enum NOT NULL DEFAULT 'DETECTED',
    outcome outcome_enum NOT NULL DEFAULT 'unresolved',

    -- The state lock. Set atomically when a responder wins the race.
    claimed_by_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
    claimed_at TIMESTAMPTZ,

    -- Lifecycle stamps (maintained by incident_lifecycle_guard).
    dispatched_at TIMESTAMPTZ,
    on_scene_at TIMESTAMPTZ,
    escalated_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    resolved_by_id UUID REFERENCES user_account(id) ON DELETE SET NULL,

    -- Independent verification (four-eyes) of the scene outcome.
    verified_by_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
    verified_at TIMESTAMPTZ,
    verification_notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chck_incident_confidence_range CHECK (
        confidence_level IS NULL OR (confidence_level >= 0 AND confidence_level <= 1)
    ),
    CONSTRAINT chck_incident_edge_ai_confidence CHECK (
        trigger_source <> 'EDGE_AI' OR confidence_level IS NOT NULL
    ),
    CONSTRAINT chck_incident_driver_required CHECK (
        trigger_source = 'CENTER_MANUAL' OR driver_id IS NOT NULL
    ),
    CONSTRAINT chck_incident_snapshot_urls_is_array CHECK (jsonb_typeof(snapshot_urls) = 'array'),

    -- claimed_by_id / claimed_at travel together, and the claim must
    -- match the status: nobody holds a DETECTED/DISPATCHING incident,
    -- and somebody must hold one that is CLAIMED..AWAITING_VERIFICATION.
    CONSTRAINT chck_incident_claim_pair CHECK (
        (claimed_by_id IS NULL) = (claimed_at IS NULL)
    ),
    CONSTRAINT chck_incident_claim_consistency CHECK (
        (status IN ('DETECTED', 'DISPATCHING') AND claimed_by_id IS NULL)
        OR (status IN ('CLAIMED', 'EN_ROUTE', 'ON_SCENE', 'AWAITING_VERIFICATION')
            AND claimed_by_id IS NOT NULL)
        OR status IN ('ESCALATED', 'RESOLVED', 'CANCELLED')
    ),

    CONSTRAINT chck_incident_terminal_stamps CHECK (
        ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
        AND ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
        AND (resolved_by_id IS NULL OR status = 'RESOLVED')
    ),

    CONSTRAINT chck_incident_verification_pair CHECK (
        (verified_by_id IS NULL) = (verified_at IS NULL)
    ),
    CONSTRAINT chck_incident_verifier_not_claimant CHECK (
        verified_by_id IS NULL OR claimed_by_id IS NULL OR verified_by_id <> claimed_by_id
    ),

    -- THE SAFETY GATE. A responder can autonomously close an incident
    -- only if it is a plain ASSIST, or a DE_ESCALATABLE one whose scene
    -- is no longer an active threat. Anything else (all HAZARD
    -- incidents, unresolved DE_ESCALATABLE ones) needs verified_at,
    -- i.e. it must pass through AWAITING_VERIFICATION first. This also
    -- closes the old hole where one responder could unilaterally call a
    -- dangerous incident a false alarm.
    CONSTRAINT chck_incident_resolution_safety_gate CHECK (
        status <> 'RESOLVED'
        OR threat_category = 'ASSIST'
        OR (threat_category = 'DE_ESCALATABLE' AND threat_level IN ('DE_ESCALATED', 'CLEAR'))
        OR verified_at IS NOT NULL
    ),
    CONSTRAINT chck_incident_resolved_has_outcome CHECK (
        status <> 'RESOLVED' OR outcome <> 'unresolved'
    )
);

CREATE TRIGGER trg_incident_updated_at
BEFORE UPDATE ON incident
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Enforces the state machine and keeps lifecycle stamps honest so the
-- Redis/API layer cannot drift the durable record into nonsense.
CREATE OR REPLACE FUNCTION incident_lifecycle_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('DETECTED', 'DISPATCHING') THEN
            RAISE EXCEPTION 'incident must be created in DETECTED or DISPATCHING, not %', NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status = 'DISPATCHING' THEN
            NEW.dispatched_at := COALESCE(NEW.dispatched_at, now());
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT is_valid_incident_transition(OLD.status, NEW.status) THEN
            RAISE EXCEPTION 'illegal incident status transition % -> % (incident %)',
                OLD.status, NEW.status, OLD.id
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.status = 'DISPATCHING' THEN
            -- Back into the pool: the claim is void, whoever held it.
            NEW.dispatched_at := COALESCE(OLD.dispatched_at, now());
            NEW.claimed_by_id := NULL;
            NEW.claimed_at := NULL;
            NEW.on_scene_at := NULL;
        ELSIF NEW.status = 'CLAIMED' THEN
            NEW.claimed_at := now();
        ELSIF NEW.status = 'ON_SCENE' THEN
            NEW.on_scene_at := COALESCE(OLD.on_scene_at, now());
        ELSIF NEW.status = 'ESCALATED' THEN
            NEW.escalated_at := now();
        ELSIF NEW.status = 'RESOLVED' THEN
            NEW.resolved_at := now();
        ELSIF NEW.status = 'CANCELLED' THEN
            NEW.cancelled_at := now();
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_incident_lifecycle_guard
BEFORE INSERT OR UPDATE ON incident
FOR EACH ROW
EXECUTE FUNCTION incident_lifecycle_guard();

-- One helper so every trigger writes audit rows the same way.
CREATE OR REPLACE FUNCTION audit_incident_event(
    p_actor_id UUID,
    p_command_center_id UUID,
    p_action audit_action,
    p_incident_id UUID,
    p_old_payload JSONB,
    p_new_payload JSONB
) RETURNS VOID AS $$
BEGIN
    INSERT INTO system_audit_log
        (actor_id, command_center_id, action, target_entity, target_id, old_payload, new_payload)
    VALUES
        (p_actor_id, p_command_center_id, p_action, 'incident', p_incident_id, p_old_payload, p_new_payload);
END;
$$ LANGUAGE plpgsql;

-- Human-raised incidents (a command center creating one on someone's
-- behalf) are audited on creation. EDGE_AI / MANUAL_SOS volume is far
-- too high to audit row-by-row; their history is the incident row.
CREATE OR REPLACE FUNCTION incident_after_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM audit_incident_event(
        current_app_user_id(), NULL, 'CREATE_INCIDENT', NEW.id, NULL,
        jsonb_build_object(
            'trigger_source', NEW.trigger_source,
            'threat_category', NEW.threat_category,
            'driver_id', NEW.driver_id
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_incident_after_insert
AFTER INSERT ON incident
FOR EACH ROW
WHEN (NEW.trigger_source = 'CENTER_MANUAL')
EXECUTE FUNCTION incident_after_insert();

-- Side effects of a status / threat / verification change: audit trail,
-- inbox notifications, and tidying the per-responder rows so the
-- assignment table never contradicts the incident.
CREATE OR REPLACE FUNCTION incident_after_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN

        IF NEW.status = 'CLAIMED' THEN
            PERFORM audit_incident_event(
                COALESCE(current_app_user_id(), NEW.claimed_by_id), NULL,
                'CLAIM_INCIDENT', NEW.id,
                jsonb_build_object('status', OLD.status),
                jsonb_build_object('status', NEW.status, 'claimed_by_id', NEW.claimed_by_id)
            );

        ELSIF NEW.status = 'DISPATCHING' AND OLD.claimed_by_id IS NOT NULL THEN
            PERFORM audit_incident_event(
                COALESCE(current_app_user_id(), OLD.claimed_by_id), NULL,
                'RELEASE_INCIDENT_CLAIM', NEW.id,
                jsonb_build_object('status', OLD.status, 'claimed_by_id', OLD.claimed_by_id),
                jsonb_build_object('status', NEW.status)
            );
            -- The old claimant must stop counting as the active
            -- claimant, or the one-active-claim index would block the
            -- next winner.
            UPDATE incident_responder_assignment
            SET status = 'STOOD_DOWN'
            WHERE incident_id = NEW.id
              AND responder_id = OLD.claimed_by_id
              AND status IN ('CLAIMED', 'EN_ROUTE', 'ARRIVED');

        ELSIF NEW.status = 'ESCALATED' THEN
            IF NEW.claimed_by_id IS NOT NULL THEN
                INSERT INTO notification (user_id, type, tone, title, body, related_entity, related_entity_id)
                VALUES (
                    NEW.claimed_by_id,
                    'incident_escalated',
                    'attention',
                    'Incident escalated',
                    'The incident you are handling has been escalated to a command center.',
                    'incident',
                    NEW.id
                );
            END IF;

        ELSIF NEW.status = 'RESOLVED' THEN
            PERFORM audit_incident_event(
                COALESCE(current_app_user_id(), NEW.resolved_by_id, NEW.verified_by_id, NEW.claimed_by_id),
                NULL, 'RESOLVE_INCIDENT', NEW.id,
                jsonb_build_object('status', OLD.status),
                jsonb_build_object(
                    'status', NEW.status,
                    'outcome', NEW.outcome,
                    'threat_category', NEW.threat_category,
                    'threat_level', NEW.threat_level,
                    'verified', NEW.verified_at IS NOT NULL
                )
            );
            INSERT INTO notification (user_id, type, tone, title, body, related_entity, related_entity_id)
            SELECT
                ara.responder_id,
                'incident_resolved',
                'success',
                'Incident resolved',
                'The incident you were dispatched to has been resolved.',
                'incident',
                NEW.id
            FROM incident_responder_assignment ara
            WHERE ara.incident_id = NEW.id
              AND ara.status IN ('CLAIMED', 'EN_ROUTE', 'ARRIVED');

        ELSIF NEW.status = 'CANCELLED' THEN
            PERFORM audit_incident_event(
                current_app_user_id(), NULL, 'CANCEL_INCIDENT', NEW.id,
                jsonb_build_object('status', OLD.status),
                jsonb_build_object('status', NEW.status)
            );
        END IF;

        -- Nothing left to accept once the incident is over.
        IF NEW.status IN ('RESOLVED', 'CANCELLED') THEN
            UPDATE incident_responder_assignment
            SET status = 'EXPIRED'
            WHERE incident_id = NEW.id AND status = 'OFFERED';
        END IF;

        -- Leaving ESCALATED means a command center (or the engine)
        -- picked it back up, so the escalation is no longer open.
        IF OLD.status = 'ESCALATED' THEN
            UPDATE incident_escalation
            SET closed_at = now()
            WHERE incident_id = NEW.id AND closed_at IS NULL;
        END IF;
    END IF;

    IF NEW.verified_at IS NOT NULL AND OLD.verified_at IS NULL THEN
        PERFORM audit_incident_event(
            COALESCE(current_app_user_id(), NEW.verified_by_id), NULL,
            'VERIFY_INCIDENT', NEW.id, NULL,
            jsonb_build_object('verified_by_id', NEW.verified_by_id, 'notes', NEW.verification_notes)
        );
    END IF;

    IF NEW.threat_level IS DISTINCT FROM OLD.threat_level
       OR NEW.threat_category IS DISTINCT FROM OLD.threat_category THEN
        PERFORM audit_incident_event(
            COALESCE(current_app_user_id(), NEW.claimed_by_id), NULL,
            'CHANGE_THREAT_LEVEL', NEW.id,
            jsonb_build_object('threat_category', OLD.threat_category, 'threat_level', OLD.threat_level),
            jsonb_build_object('threat_category', NEW.threat_category, 'threat_level', NEW.threat_level)
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_incident_after_change
AFTER UPDATE ON incident
FOR EACH ROW
WHEN (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.threat_level IS DISTINCT FROM OLD.threat_level
    OR NEW.threat_category IS DISTINCT FROM OLD.threat_category
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
)
EXECUTE FUNCTION incident_after_change();

-- One row per radial wave. The engine widens the radius wave by wave
-- (1 km -> 3 km) until someone claims or the SLA runs out.
CREATE TABLE IF NOT EXISTS incident_dispatch_wave (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    wave_number SMALLINT NOT NULL,
    radius_meters INTEGER NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,

    CONSTRAINT uq_wave_per_incident UNIQUE (incident_id, wave_number),
    CONSTRAINT chck_wave_number_positive CHECK (wave_number >= 1),
    CONSTRAINT chck_wave_radius_range CHECK (radius_meters BETWEEN 1000 AND 3000),
    CONSTRAINT chck_wave_expiry CHECK (expires_at IS NULL OR expires_at > issued_at)
);

-- The first wave is what moves an incident out of DETECTED.
CREATE OR REPLACE FUNCTION promote_incident_on_first_wave()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE incident
    SET status = 'DISPATCHING'
    WHERE id = NEW.incident_id
      AND status = 'DETECTED';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_promote_incident_on_first_wave
AFTER INSERT ON incident_dispatch_wave
FOR EACH ROW
EXECUTE FUNCTION promote_incident_on_first_wave();

-- Every responder who was offered (or directly assigned to) an
-- incident. Many rows per incident; at most ONE active claimant.
CREATE TABLE IF NOT EXISTS incident_responder_assignment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    wave_id UUID REFERENCES incident_dispatch_wave(id) ON DELETE CASCADE,
    responder_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
    status assignment_status_enum NOT NULL DEFAULT 'OFFERED',

    origin assignment_origin_enum NOT NULL DEFAULT 'WAVE_OFFER',
    assigned_by_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
    -- Meters from responder to incident when the wave query picked them
    -- — the audit trail for "why was this person chosen".
    distance_meters NUMERIC(10,2),

    offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    arrived_at TIMESTAMPTZ,
    arrival_confirmation_method arrival_confirmation_method,
    arrived_confirmed_by UUID REFERENCES user_account(id) ON DELETE SET NULL,

    decline_reason TEXT,

    -- A responder is offered an incident once; later, wider waves must
    -- skip people already contacted.
    CONSTRAINT uq_assignment_per_responder UNIQUE (incident_id, responder_id),
    CONSTRAINT chck_assignment_origin_logic CHECK (
        (origin = 'WAVE_OFFER'
            AND wave_id IS NOT NULL
            AND assigned_by_id IS NULL
            AND distance_meters IS NOT NULL)
        OR (origin = 'CENTER_ASSIGNED'
            AND wave_id IS NULL
            AND assigned_by_id IS NOT NULL)
    ),
    CONSTRAINT chck_assignment_distance_nonneg CHECK (
        distance_meters IS NULL OR distance_meters >= 0
    ),
    CONSTRAINT chck_assignment_response_consistency CHECK (
        (status = 'OFFERED' AND responded_at IS NULL)
        OR (status <> 'OFFERED' AND responded_at IS NOT NULL)
    ),
    CONSTRAINT chck_individual_arrival_consistency CHECK (
        (arrived_at IS NULL AND arrival_confirmation_method IS NULL)
        OR (arrived_at IS NOT NULL AND arrival_confirmation_method IS NOT NULL)
    ),
    CONSTRAINT chck_arrived_status_has_timestamp CHECK (
        status <> 'ARRIVED' OR arrived_at IS NOT NULL
    )
);

-- Stamps responded_at the moment an offer leaves OFFERED, so callers
-- never have to remember to.
CREATE OR REPLACE FUNCTION stamp_assignment_response_time()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status <> 'OFFERED' AND NEW.responded_at IS NULL THEN
        NEW.responded_at := now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stamp_assignment_response_time
BEFORE INSERT OR UPDATE ON incident_responder_assignment
FOR EACH ROW
EXECUTE FUNCTION stamp_assignment_response_time();

-- Pushes assignment progress up to the incident. This is what makes
-- Postgres "immediately reflect the CLAIMED lock": the winning
-- responder's row flips to CLAIMED, the incident follows in the same
-- transaction, and every other outstanding offer is voided.
CREATE OR REPLACE FUNCTION sync_incident_from_assignment()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'CLAIMED' THEN
        UPDATE incident
        SET status = 'CLAIMED', claimed_by_id = NEW.responder_id
        WHERE id = NEW.incident_id
          AND status IN ('DETECTED', 'DISPATCHING', 'ESCALATED');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'incident % cannot be claimed in its current state', NEW.incident_id
                USING ERRCODE = 'check_violation';
        END IF;

        UPDATE incident_responder_assignment
        SET status = 'LOST_RACE'
        WHERE incident_id = NEW.incident_id
          AND id <> NEW.id
          AND status = 'OFFERED';

    ELSIF NEW.status = 'EN_ROUTE' THEN
        UPDATE incident
        SET status = 'EN_ROUTE'
        WHERE id = NEW.incident_id
          AND status = 'CLAIMED'
          AND claimed_by_id = NEW.responder_id;

    ELSIF NEW.status = 'ARRIVED' THEN
        UPDATE incident
        SET status = 'ON_SCENE'
        WHERE id = NEW.incident_id
          AND status IN ('CLAIMED', 'EN_ROUTE')
          AND claimed_by_id = NEW.responder_id;

    ELSIF NEW.status = 'STOOD_DOWN' AND TG_OP = 'UPDATE'
          AND OLD.status IN ('CLAIMED', 'EN_ROUTE') THEN
        -- The claimant walked away before reaching the scene: the
        -- incident goes back into the pool for another wave.
        UPDATE incident
        SET status = 'DISPATCHING'
        WHERE id = NEW.incident_id
          AND status IN ('CLAIMED', 'EN_ROUTE')
          AND claimed_by_id = NEW.responder_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_incident_from_assignment
AFTER INSERT OR UPDATE OF status ON incident_responder_assignment
FOR EACH ROW
EXECUTE FUNCTION sync_incident_from_assignment();

-- A command center taking over an escalation by placing a responder
-- directly: audit it and put it in the responder's inbox.
CREATE OR REPLACE FUNCTION handle_center_assignment()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM audit_incident_event(
        NEW.assigned_by_id,
        (SELECT command_center_id FROM user_account WHERE id = NEW.assigned_by_id),
        'ASSIGN_RESPONDER', NEW.incident_id, NULL,
        jsonb_build_object('responder_id', NEW.responder_id, 'assignment_id', NEW.id)
    );

    INSERT INTO notification (user_id, type, tone, title, body, related_entity, related_entity_id)
    VALUES (
        NEW.responder_id,
        'dispatch_assigned',
        'attention',
        'New dispatch assignment',
        'A command center has assigned you to an incident.',
        'incident',
        NEW.incident_id
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_handle_center_assignment
AFTER INSERT ON incident_responder_assignment
FOR EACH ROW
WHEN (NEW.origin = 'CENTER_ASSIGNED')
EXECUTE FUNCTION handle_center_assignment();

-- Peers (nearby riders) notified in the same waves. They can
-- acknowledge and offer help, never verify or discredit.
CREATE TABLE IF NOT EXISTS incident_peer_response (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    wave_id UUID REFERENCES incident_dispatch_wave(id) ON DELETE SET NULL,
    peer_driver_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
    status peer_response_status NOT NULL DEFAULT 'notified',
    distance_meters NUMERIC(10,2),
    notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,

    CONSTRAINT uq_incident_peer UNIQUE (incident_id, peer_driver_id),
    CONSTRAINT chck_peer_distance_nonneg CHECK (distance_meters IS NULL OR distance_meters >= 0)
);


-- ============================================================
-- 7. ESCALATION (command centers as escalation targets)
-- ============================================================
-- Command centers no longer receive every alert. An incident reaches
-- one only when the SLA lapses with nobody claiming (SLA_TIMEOUT) or a
-- human asks for help (MANUAL_INTERVENTION). Several escalations per
-- incident are allowed (re-escalating to a different center).
--
-- APP-LAYER REQUIREMENT: insert the incident_escalation row in the same
-- transaction that moves the incident to ESCALATED.
CREATE TABLE IF NOT EXISTS incident_escalation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    command_center_id UUID NOT NULL REFERENCES command_center(id) ON DELETE RESTRICT,
    reason escalation_reason_enum NOT NULL,
    -- NULL means the system escalated (SLA sweeper).
    escalated_by_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
    notes TEXT,
    escalated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    acknowledged_by_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
    acknowledged_at TIMESTAMPTZ,
    -- Set automatically when the incident leaves ESCALATED.
    closed_at TIMESTAMPTZ,

    CONSTRAINT chck_escalation_ack_pair CHECK (
        (acknowledged_by_id IS NULL) = (acknowledged_at IS NULL)
    ),
    CONSTRAINT chck_escalation_closed_after_escalated CHECK (
        closed_at IS NULL OR closed_at >= escalated_at
    )
);

CREATE OR REPLACE FUNCTION audit_incident_escalation()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM audit_incident_event(
        COALESCE(NEW.escalated_by_id, current_app_user_id()),
        NEW.command_center_id,
        'ESCALATE_INCIDENT', NEW.incident_id, NULL,
        jsonb_build_object('reason', NEW.reason, 'escalation_id', NEW.id, 'notes', NEW.notes)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_incident_escalation
AFTER INSERT ON incident_escalation
FOR EACH ROW
EXECUTE FUNCTION audit_incident_escalation();


-- ============================================================
-- 8. POST-INCIDENT REPORTING (paperwork only)
-- ============================================================
-- A report documents what happened; it does NOT resolve the incident
-- or decide its outcome any more. Review (approve / request revision)
-- is admin paperwork QA and never touches operational state.
CREATE TABLE IF NOT EXISTS incident_report (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incident(id) ON DELETE RESTRICT,
    -- Owning CC = the reporting responder's own home command center
    -- (APP-LAYER: set from user_account.command_center_id at creation).
    command_center_id UUID NOT NULL REFERENCES command_center(id) ON DELETE RESTRICT,

    assigned_reporter_id UUID REFERENCES user_account(id) ON DELETE SET NULL,
    submitted_by_id UUID REFERENCES user_account(id) ON DELETE SET NULL,

    disposition incident_disposition_enum,

    summary TEXT NOT NULL,
    detailed_narrative TEXT,
    evidence_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    status report_status NOT NULL DEFAULT 'draft',

    reviewed_by UUID REFERENCES user_account(id) ON DELETE SET NULL,
    reviewer_notes TEXT,
    reviewed_at TIMESTAMPTZ,

    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chck_evidence_urls_array CHECK (jsonb_typeof(evidence_urls) = 'array'),
    CONSTRAINT uq_incident_report_per_incident_center UNIQUE (incident_id, command_center_id),
    CONSTRAINT chck_disposition_required_past_draft CHECK (
        status = 'draft' OR disposition IS NOT NULL
    ),
    CONSTRAINT chck_report_review_consistency CHECK (
        (status IN ('draft', 'submitted', 'under_review')
            AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (status IN ('needs_revision', 'approved')
            AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
    CONSTRAINT chck_revision_reason_required CHECK (
        status != 'needs_revision' OR reviewer_notes IS NOT NULL
    ),
    CONSTRAINT chck_report_reviewer_not_submitter CHECK (
        reviewed_by IS NULL OR reviewed_by != submitted_by_id
    )
);

CREATE TRIGGER trg_incident_report_updated_at
BEFORE UPDATE ON incident_report
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Replaces resolve_incident_on_report_submission: submission is now
-- only an audit event, not an operational one.
CREATE OR REPLACE FUNCTION audit_report_submission()
RETURNS TRIGGER AS $$
DECLARE
    v_is_new_submission BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_is_new_submission := (NEW.status = 'submitted');
    ELSE
        v_is_new_submission := (NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted');
    END IF;

    IF v_is_new_submission THEN
        INSERT INTO system_audit_log (actor_id, command_center_id, action, target_entity, target_id, new_payload)
        VALUES (
            NEW.submitted_by_id,
            NEW.command_center_id,
            'SUBMIT_INCIDENT_REPORT',
            'incident_report',
            NEW.id,
            jsonb_build_object('incident_id', NEW.incident_id, 'disposition', NEW.disposition)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_report_submission
AFTER INSERT OR UPDATE ON incident_report
FOR EACH ROW
EXECUTE FUNCTION audit_report_submission();

CREATE OR REPLACE FUNCTION notify_and_audit_report_review()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('needs_revision', 'approved') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
        INSERT INTO notification (user_id, type, tone, title, body, related_entity, related_entity_id)
        VALUES (
            COALESCE(NEW.submitted_by_id, NEW.assigned_reporter_id),
            'report_review_result',
            -- Explicit cast: a CASE over bare literals resolves to text,
            -- which Postgres will not implicitly cast into an enum column.
            CASE WHEN NEW.status = 'approved'
                THEN 'success'::notification_tone_enum
                ELSE 'attention'::notification_tone_enum
            END,
            CASE WHEN NEW.status = 'approved' THEN 'Report approved' ELSE 'Report needs revision' END,
            COALESCE(
                NEW.reviewer_notes,
                CASE WHEN NEW.status = 'approved'
                    THEN 'Your incident report has been reviewed and approved.'
                    ELSE 'Your incident report was sent back for revision.'
                END
            ),
            'incident_report',
            NEW.id
        );

        INSERT INTO system_audit_log (actor_id, command_center_id, action, target_entity, target_id, old_payload, new_payload)
        VALUES (
            NEW.reviewed_by,
            NEW.command_center_id,
            'REVIEW_INCIDENT_REPORT',
            'incident_report',
            NEW.id,
            jsonb_build_object('status', OLD.status),
            jsonb_build_object('status', NEW.status, 'reviewer_notes', NEW.reviewer_notes)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_and_audit_report_review
AFTER UPDATE ON incident_report
FOR EACH ROW
EXECUTE FUNCTION notify_and_audit_report_review();


-- ============================================================
-- 9. NOTIFICATIONS (responder mobile app inbox)
-- ============================================================
CREATE TABLE IF NOT EXISTS notification (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    type notification_type_enum NOT NULL,
    tone notification_tone_enum NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT NOT NULL,

    related_entity VARCHAR(50),
    related_entity_id UUID,

    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- 10. SYSTEM AUDIT LOGGING (Partitioned by Range)
-- ============================================================
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

CREATE TABLE system_audit_log_y2026m08 PARTITION OF system_audit_log
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE system_audit_log_y2026m09 PARTITION OF system_audit_log
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE system_audit_log_y2026m10 PARTITION OF system_audit_log
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE system_audit_log_y2026m11 PARTITION OF system_audit_log
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE system_audit_log_y2026m12 PARTITION OF system_audit_log
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE TABLE system_audit_log_default PARTITION OF system_audit_log DEFAULT;


-- ============================================================
-- 11. DASHBOARD VIEWS
-- ============================================================
-- One row per incident: the full operational picture plus response-time
-- metrics. Replaces branch_incident_logs, whose per-branch rows only
-- made sense while command centers were the initial routers.
CREATE OR REPLACE VIEW incident_logs AS
SELECT
    i.id AS incident_id,
    i.trigger_source,
    i.detected_class,
    i.confidence_level,
    i.threat_category,
    i.threat_level,
    i.status,
    i.outcome,
    i.driver_id,
    u.f_name || ' ' || u.l_name AS rider_name,
    u.deleted_at AS rider_deleted_at,
    d.hardware_serial,
    i.claimed_by_id,
    cu.f_name || ' ' || cu.l_name AS claimed_by_name,
    crp.agency AS claimed_by_agency,
    esc.command_center_id AS escalated_command_center_id,
    esc.reason AS escalation_reason,
    rep.disposition,
    rep.status AS report_status,
    i.created_at AS detected_at,
    i.dispatched_at,
    i.claimed_at,
    i.on_scene_at,
    i.escalated_at,
    i.verified_at,
    i.resolved_at,
    i.cancelled_at,
    EXTRACT(EPOCH FROM (i.claimed_at - i.created_at)) AS time_to_claim_seconds,
    EXTRACT(EPOCH FROM (i.on_scene_at - i.created_at)) AS time_to_scene_seconds,
    EXTRACT(EPOCH FROM (i.resolved_at - i.created_at)) AS time_to_resolution_seconds
FROM incident i
LEFT JOIN user_account u ON u.id = i.driver_id
LEFT JOIN device d ON d.id = i.device_id
LEFT JOIN user_account cu ON cu.id = i.claimed_by_id
LEFT JOIN r_profile crp ON crp.user_id = i.claimed_by_id
LEFT JOIN LATERAL (
    SELECT e.command_center_id, e.reason
    FROM incident_escalation e
    WHERE e.incident_id = i.id
    ORDER BY e.escalated_at DESC
    LIMIT 1
) esc ON true
LEFT JOIN LATERAL (
    SELECT r.disposition, r.status
    FROM incident_report r
    WHERE r.incident_id = i.id
    ORDER BY r.created_at DESC
    LIMIT 1
) rep ON true;

-- The command-center work queue: open escalations only.
CREATE OR REPLACE VIEW command_center_escalation_queue AS
SELECT
    e.id AS escalation_id,
    e.command_center_id,
    cc.name AS command_center_name,
    e.incident_id,
    e.reason,
    e.escalated_by_id,
    e.escalated_at,
    e.acknowledged_by_id,
    e.acknowledged_at,
    i.status AS incident_status,
    i.threat_category,
    i.threat_level,
    i.trigger_source,
    i.location,
    i.claimed_by_id,
    EXTRACT(EPOCH FROM (now() - e.escalated_at)) AS waiting_seconds
FROM incident_escalation e
JOIN command_center cc ON cc.id = e.command_center_id
JOIN incident i ON i.id = e.incident_id
WHERE e.closed_at IS NULL;


-- ============================================================
-- 12. DIAGNOSTIC VIEWS
-- ============================================================
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


-- ============================================================
-- 13. PERFORMANCE INDEXES
-- ============================================================
-- Spatial. command_center.location now serves "nearest center to
-- escalate to"; r_profile.last_known_location serves the wave query.
CREATE INDEX idx_command_center_location ON command_center USING GIST (location);
CREATE INDEX idx_incident_location ON incident USING GIST (location);
CREATE INDEX idx_r_profile_location ON r_profile USING GIST (last_known_location);

CREATE INDEX idx_user_account_cc_id ON user_account(command_center_id);
CREATE INDEX idx_device_driver_id ON device(driver_id);
CREATE INDEX idx_device_hardware_serial ON device(hardware_serial);

-- Incident hot paths: the SLA sweeper only ever scans open incidents.
CREATE INDEX idx_incident_driver_id ON incident(driver_id);
CREATE INDEX idx_incident_open_by_status ON incident(status, created_at)
    WHERE status NOT IN ('RESOLVED', 'CANCELLED');
CREATE INDEX idx_incident_claimed_by ON incident(claimed_by_id)
    WHERE claimed_by_id IS NOT NULL;
CREATE INDEX idx_incident_created_at ON incident(created_at DESC);

-- Wave / assignment. The unique partial index is the database-level
-- twin of the Redis Lua lock: two active claimants for one incident
-- are physically impossible, even if the app layer misbehaves.
CREATE UNIQUE INDEX uq_ira_one_active_claim
    ON incident_responder_assignment(incident_id)
    WHERE status IN ('CLAIMED', 'EN_ROUTE', 'ARRIVED');
CREATE INDEX idx_ira_responder ON incident_responder_assignment(responder_id);
CREATE INDEX idx_ira_responder_active ON incident_responder_assignment(responder_id)
    WHERE status IN ('CLAIMED', 'EN_ROUTE', 'ARRIVED');
CREATE INDEX idx_ira_incident_status ON incident_responder_assignment(incident_id, status);
CREATE INDEX idx_ira_wave ON incident_responder_assignment(wave_id) WHERE wave_id IS NOT NULL;

CREATE INDEX idx_ipr_peer ON incident_peer_response(peer_driver_id);
CREATE INDEX idx_ipr_incident ON incident_peer_response(incident_id, status);
CREATE INDEX idx_ipr_wave ON incident_peer_response(wave_id) WHERE wave_id IS NOT NULL;

CREATE INDEX idx_escalation_incident ON incident_escalation(incident_id);
CREATE INDEX idx_escalation_cc_open ON incident_escalation(command_center_id)
    WHERE closed_at IS NULL;

CREATE INDEX idx_audit_cc_id ON system_audit_log(command_center_id);

CREATE INDEX idx_user_session_token ON user_session(refresh_token_hash);
CREATE INDEX idx_user_session_user_id ON user_session(user_id) WHERE is_revoked = false;
CREATE INDEX idx_user_session_expires_at ON user_session(expires_at);

CREATE INDEX idx_r_profile_availability ON r_profile(availability, last_active_at);
CREATE INDEX idx_r_profile_unit ON r_profile(unit) WHERE unit IS NOT NULL;

CREATE INDEX idx_user_account_deleted_at ON user_account(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX idx_incident_report_incident ON incident_report(incident_id);
CREATE INDEX idx_incident_report_cc ON incident_report(command_center_id);
CREATE INDEX idx_incident_report_assignee ON incident_report(assigned_reporter_id);
CREATE INDEX idx_incident_report_needs_action ON incident_report(status)
    WHERE status IN ('draft', 'needs_revision');

CREATE INDEX idx_device_pairing_history_device ON device_pairing_history(device_id);
CREATE INDEX idx_device_pairing_history_driver ON device_pairing_history(driver_id);

CREATE INDEX idx_notification_user_recent ON notification(user_id, created_at DESC);
CREATE INDEX idx_notification_unread ON notification(user_id) WHERE read_at IS NULL;


-- Down Migration

DROP VIEW IF EXISTS v_table_index_usage;
DROP VIEW IF EXISTS v_index_performance;
DROP VIEW IF EXISTS command_center_escalation_queue;
DROP VIEW IF EXISTS incident_logs;

DROP TABLE IF EXISTS system_audit_log CASCADE;
DROP TABLE IF EXISTS notification CASCADE;
DROP TABLE IF EXISTS incident_report CASCADE;
DROP TABLE IF EXISTS incident_escalation CASCADE;
DROP TABLE IF EXISTS incident_peer_response CASCADE;
DROP TABLE IF EXISTS incident_responder_assignment CASCADE;
DROP TABLE IF EXISTS incident_dispatch_wave CASCADE;
DROP TABLE IF EXISTS incident CASCADE;
DROP TABLE IF EXISTS account_action_token CASCADE;
DROP TABLE IF EXISTS user_session CASCADE;
DROP TABLE IF EXISTS device_pairing_history CASCADE;
DROP TABLE IF EXISTS device CASCADE;
DROP TABLE IF EXISTS r_profile CASCADE;
DROP TABLE IF EXISTS d_profile CASCADE;
DROP TABLE IF EXISTS user_account CASCADE;
DROP TABLE IF EXISTS command_center CASCADE;

DROP FUNCTION IF EXISTS notify_and_audit_report_review();
DROP FUNCTION IF EXISTS audit_report_submission();
DROP FUNCTION IF EXISTS audit_incident_escalation();
DROP FUNCTION IF EXISTS handle_center_assignment();
DROP FUNCTION IF EXISTS sync_incident_from_assignment();
DROP FUNCTION IF EXISTS stamp_assignment_response_time();
DROP FUNCTION IF EXISTS promote_incident_on_first_wave();
DROP FUNCTION IF EXISTS incident_after_change();
DROP FUNCTION IF EXISTS incident_after_insert();
DROP FUNCTION IF EXISTS audit_incident_event(UUID, UUID, audit_action, UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS incident_lifecycle_guard();
DROP FUNCTION IF EXISTS is_valid_incident_transition(incident_status_enum, incident_status_enum);
DROP FUNCTION IF EXISTS current_app_user_id();
DROP FUNCTION IF EXISTS revoke_sessions_on_soft_delete();
DROP FUNCTION IF EXISTS set_updated_at();

DROP TYPE IF EXISTS audit_action;
DROP TYPE IF EXISTS account_token_purpose_enum;
DROP TYPE IF EXISTS account_status_enum;
DROP TYPE IF EXISTS notification_tone_enum;
DROP TYPE IF EXISTS notification_type_enum;
DROP TYPE IF EXISTS incident_disposition_enum;
DROP TYPE IF EXISTS peer_response_status;
DROP TYPE IF EXISTS assignment_status_enum;
DROP TYPE IF EXISTS assignment_origin_enum;
DROP TYPE IF EXISTS escalation_reason_enum;
DROP TYPE IF EXISTS trigger_source_enum;
DROP TYPE IF EXISTS threat_level_enum;
DROP TYPE IF EXISTS threat_category_enum;
DROP TYPE IF EXISTS incident_status_enum;
DROP TYPE IF EXISTS outcome_enum;
DROP TYPE IF EXISTS arrival_confirmation_method;
DROP TYPE IF EXISTS report_status;
DROP TYPE IF EXISTS auth_provider_enum;
DROP TYPE IF EXISTS device_status;
DROP TYPE IF EXISTS police_rank;
DROP TYPE IF EXISTS blood_type_enum;
DROP TYPE IF EXISTS service_provider;
DROP TYPE IF EXISTS agency_type;
DROP TYPE IF EXISTS cc_type;
DROP TYPE IF EXISTS user_role;
DROP TYPE IF EXISTS availability_status;