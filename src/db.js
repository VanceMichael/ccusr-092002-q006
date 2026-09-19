
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function defaultDatabasePath() {
  return process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
}

function openDatabase(databasePath) {
  const resolved = databasePath || defaultDatabasePath();
  if (resolved !== ":memory:") {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  return new DatabaseSync(resolved);
}

function applyMigrations(database, migrationsDir = MIGRATIONS_DIR) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const applied = database.prepare("SELECT version FROM schema_migrations WHERE version = ?");
  const record = database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)");
  for (const file of files) {
    const version = path.basename(file, ".sql");
    if (applied.get(version)) {
      continue;
    }
    database.exec("BEGIN");
    try {
      database.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      record.run(version);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

module.exports = { openDatabase, applyMigrations };
