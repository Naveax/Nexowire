ALTER TABLE devices
ADD COLUMN agent_version TEXT;

ALTER TABLE devices
ADD COLUMN privilege_mode TEXT
CHECK (
  privilege_mode IS NULL OR
  privilege_mode IN ('direct', 'broker')
);

ALTER TABLE devices
ADD COLUMN admin_bridge_ready INTEGER
CHECK (
  admin_bridge_ready IS NULL OR
  admin_bridge_ready IN (0, 1)
);
