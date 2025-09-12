CREATE TABLE IF NOT EXISTS fix_recommendations (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  failure_id        BIGINT NULL,
  repo_owner        VARCHAR(200) NOT NULL,
  repo_name         VARCHAR(200) NOT NULL,
  pr_number         INT NULL,
  head_sha          VARCHAR(64) NULL,

  -- Existing JSON blobs (keeps knowledge.ts working as-is)
  summary_json      LONGTEXT NOT NULL,
  changes_json      LONGTEXT NOT NULL,
  policy_json       LONGTEXT NOT NULL,
  tool_inv_json     LONGTEXT NOT NULL,
  summary_md        LONGTEXT NULL,

  -- Additional structured fields used to generate an embedded “content”
  summary_one_liner TEXT NULL,
  rationale         LONGTEXT NULL,

  -- A single document for embedding; unquote JSON path strings
  content TEXT GENERATED ALWAYS AS (
    CONCAT_WS('\n\n',
      COALESCE(summary_one_liner, ''),
      COALESCE(rationale, ''),
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(changes_json, '$[0].hunk.after')), ''),
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(changes_json, '$[1].hunk.after')), ''),
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(changes_json, '$[2].hunk.after')), '')
    )
  ) STORED,

  -- Auto-embedded vector (Amazon Titan v2; dim=1024)
  content_vector VECTOR(1024)
    GENERATED ALWAYS AS (
      EMBED_TEXT('tidbcloud_free/amazon/titan-embed-text-v2', content)
    ) STORED,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY ux_fix_failure_head (failure_id, head_sha),
  INDEX idx_repo_time (repo_owner, repo_name, created_at DESC)
);

-- Vector index requires a columnar replica (Starter supports “on demand”)
CREATE VECTOR INDEX IF NOT EXISTS idx_fix_content_vec
  ON fix_recommendations ((VEC_COSINE_DISTANCE(content_vector)))
  ADD_COLUMNAR_REPLICA_ON_DEMAND;
