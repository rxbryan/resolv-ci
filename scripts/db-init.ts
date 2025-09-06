import { createConnection } from "mysql2/promise";
import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Missing migrations directory: ${migrationsDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort(); // execute all sql files

  if (files.length === 0) {
    console.error(`No .sql files found in ${migrationsDir}`);
    process.exit(1);
  }

  // Optional: load CA if your provider requires it (e.g., TiDB Dedicated)
  const ssl: any = { minVersion: "TLSv1.2", rejectUnauthorized: true };
  const caPath = process.env.TIDB_SSL_CA_PATH;
  if (caPath && fs.existsSync(caPath)) {
    ssl.ca = fs.readFileSync(caPath, "utf8");
  }

  const conn = await createConnection({
    host: process.env.TIDB_HOST,
    port: Number(process.env.TIDB_PORT || 4000),
    user: process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE,
    ssl,
    multipleStatements: true, // allow executing the whole file at once
  });

  try {
    for (const file of files) {
      const full = path.join(migrationsDir, file);
      const sql = fs.readFileSync(full, "utf8");

      process.stdout.write(`Applying ${file} ... `);
      await conn.query(sql);
      console.log("done");
    }
  } finally {
    await conn.end();
  }

  console.log("All migrations applied.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
