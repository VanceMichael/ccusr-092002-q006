# 领域资料

燕赵电力实验室发布创新供给与应用场景两类清单后，电网单位与校内课题组对同一储能效率问题常使用不同性能指标，线下对接往往到成果转化阶段才发现条件不符。本服务把**需求征集、技术能力声明、联合验证**三个环节串到同一条数据链上。

`contracts/entities.json` 保存外部数据交换字段与规则。来源编号（`*_ref`）仅表示提交方对自身记录的识别符，示例文件不包含真实个人资料。运行时持久化文件由 `DATABASE_PATH` 决定；时间字段使用带时区偏移的 ISO 8601 字符串。

## 角色与提交

- **电网单位**（`role=grid`）提交需求（应用场景）：`POST /demands`。
- **校内课题组**（`role=research`）提交技术能力声明：`POST /capabilities`。

双方独立提交，可自行划定可公开范围（`confidentiality`：`public` / `consortium` / `bilateral`）。条目按来源编号带版本（`version` 单调递增）：再次提交同一 `ref` 自动生成新版本，旧版本置为 `superseded` 但保留可查。

能力声明的证据分两类：

- `experimental`：有实验数据支持，必须提供 `evidence_digest`（实验数据摘要）；
- `intent`：仅为待验证意向。

## 兼容门禁

只有同时满足以下条件的需求与能力才能配对进入联合验证（`POST /pairings`，否则返回 422 并给出具体不兼容原因）：

1. **指标口径一致**：`metric_code` 相同，且引用同一 `metric_revision`（同一指标定义/测试标准版本），避免“同一储能效率、不同口径”；
2. **保密级别兼容**：需求场景的保密级别不低于能力证据的保密级别（公开 < 联盟内共享 < 双边保密）。更敏感的证据可以进入更封闭的场景，反之不行。

## 双方确认与指标变更

配对创建后状态为 `proposed`，须双方分别调用确认接口（`POST /pairings/{id}/confirmations`），状态变为 `confirmed` 后才能提交联合验证。

**合作方更换指标（提交新版本）后，相关配对自动置为 `metric_changed` 并清空确认标记**：必须在新口径重新兼容的前提下重新提议配对，再经双方重新确认。系统不允许在失效确认上直接继续。

## 联合验证：只追加、保归属

联合验证结论（`POST /pairings/{id}/verifications`）只追加，**不提供更新或删除接口**：

- 每条结论记录 `result`（`pass` / `fail` / `inconclusive`）、结论文本、提交方归属（`owner_role`）；
- 同时固化当时双方的指标修订版本、保密级别与版本 ID 快照；
- 验证失败后原始失败结论与归属永久保留，后续复测通过只追加新记录，不覆盖失败历史。

## 试点转化就绪审查

试点转化前通过 `GET /exchange/readiness` 可查出每条有效能力声明：

- `has_experimental_data` / `evidence_kind`：是否有实验数据支持，还是仅待验证意向（可用 `?evidence_kind=intent|experimental` 过滤）；
- 验证总数与最新联合验证结论及其归属；
- `readiness` 判定：
  - `pending_evidence`：仅意向、无验证，不能作为有数据支撑的成果转化；
  - `unverified_experimental`：有实验数据但未经联合验证；
  - `verified_pass` / `verification_failed` / `verification_inconclusive`：按最新联合验证结论标注（失败同样明确标出）。
