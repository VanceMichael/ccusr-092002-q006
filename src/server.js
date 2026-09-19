
const { openMigratedDatabase } = require("./db");
const { createStore } = require("./store");
const { createServer: createHttpServer } = require("./http");

// createServer() 兼容无参调用：按 DATABASE_PATH 打开并执行迁移；
// 测试可传入临时数据库路径或已打开的连接。
function createServer(databaseOrPath) {
  const database =
    databaseOrPath && typeof databaseOrPath === "object"
      ? databaseOrPath
      : openMigratedDatabase(databaseOrPath);
  const store = createStore(database);
  return createHttpServer(store);
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer(process.env.DATABASE_PATH).listen(port, "0.0.0.0");
}

module.exports = { createServer };
