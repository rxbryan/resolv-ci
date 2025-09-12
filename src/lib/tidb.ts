import {
  Sequelize, DataTypes,
  UniqueConstraintError,
  ConnectionError,
  DatabaseError,
} from "sequelize";
import 'dotenv/config';
import mysql2 from 'mysql2';

import { sha1, tailLines, normalize, templateize } from "@/lib/text"; // ← use shared helpers

export type OutboundActionStatus = "staged" | "dispatched" | "error";

// --- singleton for Next.js dev/serverless ---
const globalForSequelize = global as unknown as { sequelize?: Sequelize };
export const sequelize =
  globalForSequelize.sequelize ??
  new Sequelize(
    process.env.TIDB_DATABASE ?? "",
    process.env.TIDB_USER ?? "",
    process.env.TIDB_PASSWORD ?? "",
    { 
      dialectModule: mysql2,
      dialect: 'mysql',
      host: process.env.TIDB_HOST,
      port: Number(process.env.TIDB_PORT ?? "4000"),
      dialectOptions: {
        ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
        connectTimeout: 30000,       // ⬅️ 30s to ride out cold starts/slow networks
      },
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,             // wait up to 30s to get a connection
        idle: 10000,
      },
      logging: false,
    }
  );
if (!globalForSequelize.sequelize) globalForSequelize.sequelize = sequelize;


function isTransient(e: any) {
  const code = e?.parent?.code || e?.code || "";
  return (
    e instanceof ConnectionError ||
    /ECONNRESET|ETIMEDOUT|PROTOCOL_CONNECTION_LOST/.test(code) ||
    (e instanceof DatabaseError && /Deadlock|Lock wait timeout/i.test(e.message))
  );
}


/**
 * Switch just WebhookEvent and buildfailure to sequelize.define(...) (no classes), keep classes for the other models.
 * This avoids class identity problems for the high-churn webhook path.
 */
// --- BuildFailure (sequelize.define) ---
export const BuildFailure =
  sequelize.models.build_failures ??
  sequelize.define(
    "build_failures",
    {
      failure_id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      run_id: { type: DataTypes.STRING(128), unique: true, allowNull: true },
      repo_owner: { type: DataTypes.STRING(200), allowNull: false },
      repo_name: { type: DataTypes.STRING(200), allowNull: false },
      pr_number: { type: DataTypes.INTEGER, allowNull: true },
      commit_sha: { type: DataTypes.STRING(64), allowNull: false },
      log_content: { type: DataTypes.TEXT("long"), allowNull: true },
      installation_id: { type: DataTypes.BIGINT, allowNull: true },

      /** NEW columns */
      error_signature_v1: { type: DataTypes.STRING(40), allowNull: true },
      error_signature_v2: { type: DataTypes.STRING(40), allowNull: true },
      norm_tail: { type: DataTypes.TEXT, allowNull: true },

      status: {
        type: DataTypes.ENUM("new", "analyzing", "proposed", "applied", "skipped"),
        defaultValue: "new",
        allowNull: false,
      },
      failure_timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    },
    {
      tableName: "build_failures",
      timestamps: false,
      indexes: [
        { fields: ["repo_owner", "repo_name"] },
        { unique: true, fields: ["run_id"] },
        { fields: ["error_signature_v1", "failure_timestamp"] },
        { fields: ["error_signature_v2", "failure_timestamp"] },
      ],
    }
  );


export const WebhookEvent =
  sequelize.models.webhook_events ??
  sequelize.define("webhook_events", {
    delivery_id: { type: DataTypes.STRING(128), primaryKey: true },
    event_type:  { type: DataTypes.STRING(64), allowNull: true },
    // TEXT to avoid JSON dialect quirks; store stringified JSON below
    payload_json:{ type: DataTypes.TEXT("long"), allowNull: true },
    received_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: "webhook_events",
    timestamps: false,
  });

// robust writer (stringify payload; idempotent on PK)
export async function recordWebhookDelivery(deliveryId: string, eventType: string | null, payload: any) {
  const safePayload = payload == null ? null : JSON.stringify(payload, (_k, v) => (v === undefined ? null : v));
  try {
    await (WebhookEvent as any).create({
      delivery_id: deliveryId,
      event_type: eventType ?? null,
      payload_json: safePayload,
    });
    return true;
  } catch (e: any) {
    if (isTransient(e)) {
      console.warn("[webhook] DB transient in WebHookEvent:", e?.message || e);
      return false; // treat as logged=false but don’t crash webhook
    }
    // still ignore duplicate delivery_id
    if (e?.name === "SequelizeUniqueConstraintError") return false;
    throw e;
  }
}

/**
 * Idempotent write:
 * - If runId present: INSERT ... ON DUPLICATE KEY UPDATE no-op (keeps existing row untouched)
 * - If no runId: plain insert (NULL is allowed multiple times in UNIQUE in MySQL)
 */

/** Insert (or no-op upsert) with signatures if logContent is provided */
export async function logBuildFailure(params: {
  repoOwner: string;
  repoName: string;
  prNumber?: number | null;
  commitSha: string;
  logContent?: string;            // may be undefined at early ingest
  runId?: string | null;
  installationId?: number | null;
}) {
  const MAX_RETRIES = 3;
  let attempt = 0;

  // Compute signatures only if we have log content
  const tail = params.logContent ? tailLines(params.logContent, 200) : "";
  const norm = tail ? normalize(tail) : "";
  const sigV1 = norm ? sha1(norm) : null;
  const sigV2 = norm ? sha1(templateize(norm)) : null;

  const values = {
    run_id: params.runId ?? null,
    repo_owner: params.repoOwner,
    repo_name: params.repoName,
    pr_number: params.prNumber ?? null,
    commit_sha: params.commitSha,
    log_content: params.logContent ?? null,
    installation_id: params.installationId ?? null,
    error_signature_v1: sigV1,
    error_signature_v2: sigV2,
    norm_tail: norm || null,
    status: "new" as const,
  };

  // If we have a runId, do an idempotent insert-or-noop
  if (params.runId) {
    const q = `
      INSERT INTO build_failures
        (run_id, repo_owner, repo_name, pr_number, commit_sha, log_content,
         installation_id, error_signature_v1, error_signature_v2, norm_tail, status)
      VALUES
        (:run_id, :repo_owner, :repo_name, :pr_number, :commit_sha, :log_content,
         :installation_id, :error_signature_v1, :error_signature_v2, :norm_tail, :status)
      ON DUPLICATE KEY UPDATE
        run_id = run_id
    `;
    while (true) {
      try {
        await sequelize.query(q, { replacements: values });
        return;
      } catch (e: any) {
        attempt++;
        if (!isTransient(e) || attempt >= MAX_RETRIES) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  // No runId: simple insert with retries
  while (true) {
    try {
      await BuildFailure.create(values as any);
      return;
    } catch (e: any) {
      if (e instanceof UniqueConstraintError) return; // treat duplicate as success
      attempt++;
      if (!isTransient(e) || attempt >= MAX_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/**
 * define only the usable columns; the generated content and content_vector live purely in SQL
 */
export const FixRecommendation =
  sequelize.models.fix_recommendations ??
  sequelize.define(
    "fix_recommendations",
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      failure_id: { type: DataTypes.BIGINT, allowNull: true },
      repo_owner: { type: DataTypes.STRING(200), allowNull: false },
      repo_name:  { type: DataTypes.STRING(200), allowNull: false },
      pr_number:  { type: DataTypes.INTEGER, allowNull: true },
      head_sha:   { type: DataTypes.STRING(64), allowNull: true },
      summary_one_liner: { type: DataTypes.TEXT, allowNull: true },
      rationale:         { type: DataTypes.TEXT("long"), allowNull: true },
      changes_json:      { type: DataTypes.JSON, allowNull: true },
      created_at:        { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: "fix_recommendations", timestamps: false }
  );

  export const OutboundAction = sequelize.define(
    "outbound_actions", 
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      action_hash: { type: DataTypes.STRING(64), unique: true, allowNull: false },
      action_type: { type: DataTypes.ENUM("pr_review"), allowNull: false, defaultValue: "pr_review" },
      head_sha: { type: DataTypes.STRING(64), allowNull: true },
      installation_id: { type: DataTypes.BIGINT, allowNull: true },
      payload_json: { type: DataTypes.TEXT("long"), allowNull: false }, // LONGTEXT
      status: { type: DataTypes.ENUM("staged", "dispatched", "error"), allowNull: false, defaultValue: "staged" },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      dispatched_at: { type: DataTypes.DATE, allowNull: true },
      last_error: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: "outbound_actions",
      timestamps: false,
      indexes: [
        { unique: true, fields: ["action_hash"] },
        { fields: ["status", "id"] },                 // <- composite for faster queue scans
        { fields: ["head_sha"] },
        { fields: ["installation_id"] },
      ],
    }
  );
  