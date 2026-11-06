-- P0 #587: run ONLY on an explicitly authorized PostgreSQL deployment
-- outside the Agent+gateway rollback trust boundary. Schema alone is NOT
-- anti-rollback protection against restore of PostgreSQL itself.
BEGIN;
CREATE TABLE IF NOT EXISTS witness_devices (
 device_id UUID PRIMARY KEY, owner_id UUID NOT NULL, epoch UUID NOT NULL,
 generation BIGINT NOT NULL CHECK (generation>=1),
 state TEXT NOT NULL CHECK (state IN ('active','frozen'))
);
CREATE TABLE IF NOT EXISTS witness_clock (
 id INTEGER PRIMARY KEY CHECK(id=1),
 last_sequence BIGINT NOT NULL CHECK(last_sequence>=0)
);
-- Fresh authority deployment ONLY. Never initialize this counter over old
-- historical reservations: operator migration must preserve trusted history.
INSERT INTO witness_clock(id,last_sequence) VALUES(1,0)
 ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS witness_reservations (
 sequence BIGINT PRIMARY KEY,
 request_id UUID NOT NULL UNIQUE,
 device_id UUID NOT NULL REFERENCES witness_devices(device_id),
 owner_id UUID NOT NULL, epoch UUID NOT NULL,
 fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
 capability TEXT NOT NULL CHECK (char_length(capability) BETWEEN 1 AND 128)
);
CREATE INDEX IF NOT EXISTS witness_reservations_device_id_idx
 ON witness_reservations(device_id);
COMMIT;
