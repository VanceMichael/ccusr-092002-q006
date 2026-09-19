# 电力科研供需清单双向匹配

科研团队的技术能力与电网方的应用条件分别提交，双方的指标声明带版本并在验证后保留实验出处。

本服务采用 HTTP 接口和 SQLite 本地文件。运行参数 `PORT` 指定监听端口，`DATABASE_PATH` 指定数据文件；`fixtures/example.json` 保存不含真实身份的交换示例，`contracts/entities.json` 记录字段约定，`docs/domain.md` 介绍来源与范围。

## 本地开发

`make migrate` 初始化数据文件，`make test` 运行现有自动化检查，`make run` 启动服务。`docker compose up --build` 可以启动隔离容器，`APP_PORT` 可调整宿主机端口。

## 接口概览

- `POST /declarations` 提交指标声明（含可公开范围、保密级别、带版本的证据摘要）
- `GET /declarations` 按 `party_role`、`metric_code` 查询声明
- `POST /declarations/:id/revisions` 更换指标或证据，未结案会话回到待确认
- `POST /verification-sessions` 建立联合验证（校验指标口径与保密级别兼容）
- `POST /verification-sessions/:id/confirm` 双方各自确认后激活会话
- `POST /verification-sessions/:id/results` 录入验证结论（只追加，含归属）
- `GET /verification-sessions/:id` 查看会话、双方声明与全部结论
- `GET /pilot-readiness` 试点转化前查询有实验数据支持与仅为意向的声明
