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


// --- BuildFailure ---
export class BuildFailure extends Model<
  InferAttributes<BuildFailure>,
  InferCreationAttributes<BuildFailure>
> {
  declare failure_id: CreationOptional<number>;
  declare run_id: string | null;
  declare repo_owner: string;
  declare repo_name: string;
  declare pr_number: number | null;
  declare commit_sha: string;
  declare log_content: string | null;
  declare status: "new" | "analyzing" | "proposed" | "applied" | "skipped";
  declare failure_timestamp: CreationOptional<Date>;
}

if (!sequelize.models.build_failures) {
  BuildFailure.init(
    {
      failure_id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      run_id: { type: DataTypes.STRING(128), unique: true, allowNull: true },
      repo_owner: { type: DataTypes.STRING(200), allowNull: false },
      repo_name: { type: DataTypes.STRING(200), allowNull: false },
      pr_number: { type: DataTypes.INTEGER, allowNull: true },
      commit_sha: { type: DataTypes.STRING(64), allowNull: false },
      log_content: { type: DataTypes.TEXT("long"), allowNull: true },
      status: {
        type: DataTypes.ENUM("new", "analyzing", "proposed", "applied", "skipped"),
        defaultValue: "new",
        allowNull: false
      },
      failure_timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    },
    { sequelize, modelName: "build_failures", tableName: "build_failures", timestamps: false }
  );
}

/**
 * Switch just WebhookEvent to sequelize.define(...) (no classes), keep classes for the other models.
 * This avoids class identity problems for the high-churn webhook path.
 */
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
  };


  // If we have a runId, do a no-op upsert to avoid changing existing row/status
  if (params.runId) {
    const q = `
      INSERT INTO build_failures
        (run_id, repo_owner, repo_name, pr_number, commit_sha, log_content, status)
      VALUES
        (:run_id, :repo_owner, :repo_name, :pr_number, :commit_sha, :log_content, :status)
      ON DUPLICATE KEY UPDATE
        run_id = run_id  -- no-op; preserves existing row
    `;
    while (true) {
      try {
        await sequelize.query(q, { replacements: values });
        return; // success or duplicate treated as success
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
      // Duplicate on NULL run_id shouldn't happen; but just in case:
      if (e instanceof UniqueConstraintError) return;
      attempt++;
      if (!isTransient(e) || attempt >= MAX_RETRIES) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}
