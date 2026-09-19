
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function openDatabase(databasePath = process.env.DATABASE_PATH) {
  const resolvedPath =
    databasePath || path.join(process.cwd(), "data", "app.sqlite3");
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const database = new DatabaseSync(resolvedPath);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  for (const file of listMigrationFiles()) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    database.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
}

function openMigratedDatabase(databasePath) {
  const database = openDatabase(databasePath);
  runMigrations(database);
  return database;
}

module.exports = { openDatabase, runMigrations, openMigratedDatabase };
