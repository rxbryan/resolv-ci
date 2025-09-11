CREATE TABLE IF NOT EXISTS build_failures (
  failure_id        BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id            VARCHAR(128) UNIQUE NULL,
  repo_owner        VARCHAR(200) NOT NULL,
  repo_name         VARCHAR(200) NOT NULL,
  pr_number         INT NULL,
  commit_sha        VARCHAR(64) NOT NULL,
  log_content       LONGTEXT NULL,
  installation_id   BIGINT NULL,

  -- persisted signatures + normalized tail
  error_signature_v1 CHAR(40) NULL,
  error_signature_v2 CHAR(40) NULL,
  norm_tail          TEXT NULL,

  -- auto-embedded vector (Titan v2, dim=1024) generated from norm_tail
  norm_tail_vec VECTOR(1024)
    GENERATED ALWAYS AS (
      EMBED_TEXT('tidbcloud_free/amazon/titan-embed-text-v2', norm_tail)
    ) STORED,

  status ENUM('new','analyzing','proposed','applied','skipped') NOT NULL DEFAULT 'new',
  failure_timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- helpful secondary indexes
CREATE INDEX IF NOT EXISTS idx_bf_repo           ON build_failures (repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_bf_repo_sig1_time ON build_failures (repo_owner, repo_name, error_signature_v1, failure_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_bf_repo_sig2_time ON build_failures (repo_owner, repo_name, error_signature_v2, failure_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_bf_repo_time      ON build_failures (repo_owner, repo_name, failure_timestamp DESC);


ALTER TABLE build_failures
  ADD VECTOR INDEX idx_bf_norm_tail_vec ((VEC_COSINE_DISTANCE(norm_tail_vec)))
  ADD_COLUMNAR_REPLICA_ON_DEMAND;