ALTER TABLE build_failures ADD COLUMN IF NOT EXISTS installation_id BIGINT NULL;
ALTER TABLE outbound_actions ADD COLUMN IF NOT EXISTS installation_id BIGINT NULL;
