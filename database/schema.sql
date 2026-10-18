-- Operational data lives separately from control-plane runs and traces.
CREATE SCHEMA IF NOT EXISTS operations;

CREATE TABLE IF NOT EXISTS operations.scopes (
  run_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  actor_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer','technician','supervisor')),
  facility_id text NOT NULL,
  tenant_id text NOT NULL,
  scenario_clock timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS operations.assets (
  run_id uuid NOT NULL REFERENCES operations.scopes ON DELETE CASCADE,
  id text NOT NULL,
  facility_id text NOT NULL,
  tenant_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','offline','degraded','standby')),
  notes text NOT NULL DEFAULT '',
  PRIMARY KEY (run_id,id)
);
CREATE TABLE IF NOT EXISTS operations.telemetry (
  run_id uuid NOT NULL,
  id text NOT NULL,
  asset_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  temperature double precision NOT NULL,
  temperature_unit text NOT NULL,
  vibration double precision NOT NULL,
  vibration_unit text NOT NULL,
  sensor_status text NOT NULL,
  PRIMARY KEY (run_id,id),
  FOREIGN KEY (run_id,asset_id) REFERENCES operations.assets ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS operations.manuals (
  run_id uuid NOT NULL,
  id text NOT NULL,
  asset_id text NOT NULL,
  revision text NOT NULL,
  approved boolean NOT NULL,
  effective_at timestamptz NOT NULL,
  temperature_limit_c double precision NOT NULL,
  vibration_limit_mm_s double precision NOT NULL,
  procedure text NOT NULL,
  required_part_id text,
  PRIMARY KEY (run_id,id),
  FOREIGN KEY (run_id,asset_id) REFERENCES operations.assets ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS operations.inventory (
  run_id uuid NOT NULL REFERENCES operations.scopes ON DELETE CASCADE,
  id text NOT NULL,
  facility_id text NOT NULL,
  tenant_id text NOT NULL,
  name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (run_id,id)
);
CREATE TABLE IF NOT EXISTS operations.technicians (
  run_id uuid NOT NULL REFERENCES operations.scopes ON DELETE CASCADE,
  id text NOT NULL,
  facility_id text NOT NULL,
  tenant_id text NOT NULL,
  name text NOT NULL,
  certifications jsonb NOT NULL CHECK (jsonb_typeof(certifications) = 'array'),
  available boolean NOT NULL,
  PRIMARY KEY (run_id,id)
);
CREATE TABLE IF NOT EXISTS operations.reservations (
  run_id uuid NOT NULL,
  id uuid NOT NULL,
  asset_id text NOT NULL,
  part_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id,id),
  FOREIGN KEY (run_id,asset_id) REFERENCES operations.assets,
  FOREIGN KEY (run_id,part_id) REFERENCES operations.inventory
);
CREATE TABLE IF NOT EXISTS operations.approval_requests (
  run_id uuid NOT NULL,
  id uuid NOT NULL,
  asset_id text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','approved','rejected')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id,id),
  FOREIGN KEY (run_id,asset_id) REFERENCES operations.assets
);
CREATE TABLE IF NOT EXISTS operations.work_orders (
  run_id uuid NOT NULL,
  id uuid NOT NULL,
  asset_id text NOT NULL,
  title text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('normal','urgent')),
  status text NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids) = 'array'),
  reservation_id uuid,
  technician_id text,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id,id),
  -- Another request key must not create a second draft for the same asset investigation.
  UNIQUE (run_id,asset_id),
  FOREIGN KEY (run_id,asset_id) REFERENCES operations.assets,
  FOREIGN KEY (run_id,reservation_id) REFERENCES operations.reservations,
  FOREIGN KEY (run_id,technician_id) REFERENCES operations.technicians
);
-- Save the response with the mutation so a retry can recover after a lost reply.
CREATE TABLE IF NOT EXISTS operations.idempotency (
  run_id uuid NOT NULL REFERENCES operations.scopes ON DELETE CASCADE,
  actor_id text NOT NULL,
  tool text NOT NULL,
  key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  response_status integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id,actor_id,tool,key)
);
CREATE TABLE IF NOT EXISTS operations.audit (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES operations.scopes ON DELETE CASCADE,
  actor_id text NOT NULL,
  tool text NOT NULL,
  status integer NOT NULL,
  args jsonb NOT NULL,
  result jsonb NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS audit_run_created ON operations.audit(run_id,created_at);
CREATE INDEX IF NOT EXISTS telemetry_asset_observed ON operations.telemetry(run_id,asset_id,observed_at DESC);
