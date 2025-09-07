import {
  Sequelize, Model, DataTypes,
  InferAttributes, InferCreationAttributes, CreationOptional,
  UniqueConstraintError,
  ConnectionError,
  DatabaseError,
} from "sequelize";
import 'dotenv/config';
import mysql2 from 'mysql2';

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
  (sequelize.models.build_failures as any) ??
  sequelize.define(
    "build_failures",
    {
      failure_id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      run_id: {
        type: DataTypes.STRING(128),
        allowNull: true,
        unique: true,
      },
      repo_owner: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      repo_name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      pr_number: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      commit_sha: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      log_content: {
        type: DataTypes.TEXT("long"),
        allowNull: true,
      },
      installation_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM("new", "analyzing", "proposed", "applied", "skipped"),
        allowNull: false,
        defaultValue: "new",
      },
      failure_timestamp: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "build_failures",
      timestamps: false,
      indexes: [
        { fields: ["repo_owner", "repo_name"] },
        { unique: true, fields: ["run_id"] },
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

export async function logBuildFailure(params: {
  repoOwner: string;
  repoName: string;
  prNumber?: number | null;
  commitSha: string;
  logContent: string;
  runId?: string | null;
  installationId?: number | null;
}) {
  const MAX_RETRIES = 3;
  let attempt = 0;

  const values = {
    run_id: params.runId ?? null,
    repo_owner: params.repoOwner,
    repo_name: params.repoName,
    pr_number: params.prNumber ?? null,
    commit_sha: params.commitSha,
    log_content: params.logContent,
    status: "new" as const,
    installation_id: params.installationId ?? null, // ⬅️ NEW
  };

  // If we have a runId, do an idempotent upsert.
  // Keep existing row as-is; only backfill installation_id if it was NULL.
  if (params.runId) {
    const q = `
      INSERT INTO build_failures
        (run_id, repo_owner, repo_name, pr_number, commit_sha, log_content, status, installation_id)
      VALUES
        (:run_id, :repo_owner, :repo_name, :pr_number, :commit_sha, :log_content, :status, :installation_id)
      ON DUPLICATE KEY UPDATE
        run_id = run_id,                                -- no-op
        installation_id = IFNULL(installation_id, VALUES(installation_id))  -- backfill if null
    `;
    while (true) {
      try {
        await sequelize.query(q, { replacements: values });
        return; // success (insert) or treated-as-success (duplicate)
      } catch (e: any) {
        attempt++;
        if (!isTransient(e) || attempt >= MAX_RETRIES) throw e;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  // No runId: regular insert with transient retries only
  while (true) {
    try {
      await BuildFailure.create(values as any);
      return;
    } catch (e: any) {
      if (e instanceof UniqueConstraintError) return; // extremely unlikely when run_id is NULL
      attempt++;
      if (!isTransient(e) || attempt >= MAX_RETRIES) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}
