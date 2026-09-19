
const { openDatabase, applyMigrations } = require("../src/db");

const database = openDatabase();
applyMigrations(database);
database.close();
console.log(`数据库迁移完成：${process.env.DATABASE_PATH || "data/app.sqlite3"}`);
