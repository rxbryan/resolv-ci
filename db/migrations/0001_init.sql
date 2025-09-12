create table if not exists webhook_events (
  delivery_id varchar(128) primary key,
  event_type varchar(64),
  payload_json json,
  received_at timestamp default current_timestamp
);


CREATE TABLE IF NOT EXISTS outbound_actions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  action_hash VARCHAR(64) NOT NULL,
  action_type ENUM('pr_review') NOT NULL DEFAULT 'pr_review',
  head_sha VARCHAR(64) NULL,
  installation_id BIGINT NULL,
  payload_json LONGTEXT NOT NULL,
  status ENUM('staged','dispatched','error') NOT NULL DEFAULT 'staged',
  attempt_count INT NOT NULL DEFAULT 0,
  dispatched_at DATETIME NULL,
  last_error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY ux_outbound_action_hash (action_hash),
  KEY ix_status_id (status, id),
  KEY ix_head_sha (head_sha),
  KEY ix_installation_id (installation_id)
);
