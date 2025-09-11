-- NOTE: Titan v2 has 1024 dims.

CREATE TABLE IF NOT EXISTS fix_recommendations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  failure_id BIGINT NULL,
  repo_owner VARCHAR(200) NOT NULL,
  repo_name  VARCHAR(200) NOT NULL,
  pr_number  INT NULL,
  head_sha   VARCHAR(64) NULL,

  summary_one_liner TEXT NULL,
  rationale         LONGTEXT NULL,
  changes_json      JSON NULL,

  -- Single “document” used for embedding 
  content TEXT GENERATED ALWAYS AS (
    CONCAT_WS('\n\n',
      COALESCE(summary_one_liner, ''),
      COALESCE(rationale, ''),
      JSON_EXTRACT(changes_json, '$[0].hunk.after'),
      JSON_EXTRACT(changes_json, '$[1].hunk.after'),
      JSON_EXTRACT(changes_json, '$[2].hunk.after')
    )
  ) STORED,

  -- Auto-embedded vector (Titan v2 hosted by TiDB Cloud; no API key)
  content_vector VECTOR(1024) GENERATED ALWAYS AS (
    EMBED_TEXT('tidbcloud_free/amazon/titan-embed-text-v2', content)
  ) STORED,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_repo_time (repo_owner, repo_name, created_at DESC),
  VECTOR INDEX ((VEC_COSINE_DISTANCE(content_vector)))
);

