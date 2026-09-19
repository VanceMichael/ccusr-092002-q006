# 电力科研供需清单双向匹配

科研团队的技术能力与电网方的应用条件分别提交，双方的指标声明带版本并在验证后保留实验出处；只有指标口径与保密级别兼容的条目才能进入联合验证，更换指标须双方重新确认。

本服务采用 HTTP 接口和 SQLite 本地文件。运行参数 `PORT` 指定监听端口，`DATABASE_PATH` 指定数据文件；`fixtures/example.json` 保存不含真实身份的交换示例，`contracts/entities.json` 记录字段约定，`docs/domain.md` 介绍领域规则与范围。

## 本地开发

`make migrate` 初始化数据文件，`make test` 运行现有自动化检查，`make run` 启动服务。`docker compose up --build` 可以启动隔离容器，`APP_PORT` 可调整宿主机端口。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/parties` | 注册电网单位（`grid`）或课题组（`research`） |
| POST | `/demands` | 电网方提交需求/应用场景（同 `demand_ref` 再次提交生成新版本） |
| POST | `/capabilities` | 课题组提交带证据的能力声明（`experimental` 须带 `evidence_digest`；同 `capability_ref` 再次提交生成新版本） |
| GET | `/demands`、`/demands/{ref}` | 有效需求列表 / 某条需求的全部版本 |
| GET | `/capabilities`、`/capabilities/{ref}` | 有效能力列表（可按 `?evidence_kind=` 过滤）/ 全部版本 |
| POST | `/pairings` | 配对提议；指标口径或保密级别不兼容返回 422 |
| POST | `/pairings/{id}/confirmations` | 双方分别确认，两方都确认后状态变为 `confirmed` |
| POST | `/pairings/{id}/verifications` | 提交联合验证结论（只追加，失败也保留） |
| GET | `/pairings`、`/pairings/{id}` | 配对列表 / 配对详情（含全部验证结论） |
| GET | `/exchange/readiness` | 试点转化就绪审查，区分有实验数据支持与待验证意向 |

## 流程示例

```bash
# 1. 双方注册
curl -s -XPOST localhost:8080/parties -d '{"ref":"GRID-DEMO","role":"grid","name":"示例电网单位"}'
curl -s -XPOST localhost:8080/parties -d '{"ref":"TECH-DEMO","role":"research","name":"示例课题组"}'

# 2. 独立提交需求与能力声明（指标代码与修订版本一致，保密级别兼容）
curl -s -XPOST localhost:8080/demands -d '{
  "party_ref":"GRID-DEMO","demand_ref":"GRID-DEMAND-1","title":"储能效率场景",
  "metric_code":"storage_efficiency","metric_revision":"GB/T-36558-2024",
  "confidentiality":"consortium"}'
curl -s -XPOST localhost:8080/capabilities -d '{
  "party_ref":"TECH-DEMO","capability_ref":"TECH-CAP-1","title":"储能效率优化",
  "metric_code":"storage_efficiency","metric_revision":"GB/T-36558-2024",
  "confidentiality":"public","evidence_kind":"experimental",
  "evidence_digest":"sha256:demo-digest-0001"}'

# 3. 兼容门禁通过后配对，双方分别确认
curl -s -XPOST localhost:8080/pairings -d '{"demand_ref":"GRID-DEMAND-1","capability_ref":"TECH-CAP-1"}'
curl -s -XPOST localhost:8080/pairings/<配对ID>/confirmations -d '{"party_ref":"GRID-DEMO"}'
curl -s -XPOST localhost:8080/pairings/<配对ID>/confirmations -d '{"party_ref":"TECH-DEMO"}'

# 4. 联合验证（失败结论与归属永久保留，只能追加）
curl -s -XPOST localhost:8080/pairings/<配对ID>/verifications -d '{
  "party_ref":"GRID-DEMO","result":"fail","conclusion":"工况外效率低于阈值"}'

# 5. 试点转化前审查：哪些声明有实验数据、哪些只是待验证意向
curl -s 'localhost:8080/exchange/readiness'
```

任一方提交新版本更换指标口径或保密范围后，相关配对自动变为 `metric_changed`，须按新版本重新提议并经双方重新确认，才能继续联合验证。
