# 领域资料

科研团队的技术能力与电网方的应用条件分别提交，双方的指标声明带版本并在验证后保留实验出处。

`contracts/entities.json` 保存外部数据的交换字段与枚举约定。来源编号仅表示提交方对同一记录的识别符，示例文件不包含真实个人资料。运行时持久化文件由 `DATABASE_PATH` 决定；时间字段使用带时区偏移的 ISO 8601 字符串。

## 流程与规则

1. **独立提交**：供需双方各自提交指标声明（`POST /declarations`），包含可公开范围（`public_scope`）、保密级别（`confidentiality_level`）和带版本（`metric_revision`）的指标证据摘要（`evidence_digest`）。`evidence_kind` 区分实验数据（`experimental_data`）与待验证意向（`intent`）。
2. **兼容校验**：只有指标口径（`metric_code` 与 `metric_revision` 均一致）且保密级别相同的双方声明才能建立联合验证会话（`POST /verification-sessions`），否则返回 422。
3. **双方确认**：会话建立后为待确认状态，双方各自确认（`POST /verification-sessions/:id/confirm`）后才激活。任何一方更换指标或证据（`POST /declarations/:id/revisions`）后，未结案会话回到待确认状态，双方须重新确认；变更历史保存在 `declaration_revisions`。
4. **验证结论**：激活的会话可录入验证结果（`POST /verification-sessions/:id/results`）。结果只追加不修改，失败的原始结论与归属（`attribution`：科研方 / 电网方 / 双方）永久保留；结案后的会话不再接受新结果，复验需建立新会话。
5. **试点转化**：`GET /pilot-readiness` 按声明列出哪些有实验数据支持（`supported`）、哪些只是待验证的意向（`intent`），并附联合验证状态（`passed` / `failed` / `unverified`），可按 `metric_code` 过滤。
