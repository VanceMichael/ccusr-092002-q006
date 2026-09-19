
const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("../src/server");

async function startServer(context) {
  const database = new DatabaseSync(":memory:");
  const server = createServer({ database });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

async function postJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

function researchDeclaration(overrides = {}) {
  return {
    party_role: "research",
    party_ref: "TECH-DEMO",
    metric_code: "storage_efficiency",
    metric_revision: "v1",
    evidence_digest: "sha256:demo-research",
    evidence_kind: "experimental_data",
    confidentiality_level: "internal",
    public_scope: "summary",
    ...overrides,
  };
}

function demandDeclaration(overrides = {}) {
  return {
    party_role: "demand",
    party_ref: "GRID-DEMO",
    metric_code: "storage_efficiency",
    metric_revision: "v1",
    evidence_digest: "sha256:demo-demand",
    evidence_kind: "intent",
    confidentiality_level: "internal",
    public_scope: "summary",
    ...overrides,
  };
}

async function submitPair(port, researchOverrides = {}, demandOverrides = {}) {
  const research = await postJson(port, "/declarations", researchDeclaration(researchOverrides));
  const demand = await postJson(port, "/declarations", demandDeclaration(demandOverrides));
  assert.equal(research.status, 201);
  assert.equal(demand.status, 201);
  return { researchId: research.body.declaration.id, demandId: demand.body.declaration.id };
}

test("健康接口返回服务状态", async (context) => {
  const port = await startServer(context);
  const { status, body } = await getJson(port, "/health");
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "ok" });
});

test("提交声明缺少必填字段被拒绝", async (context) => {
  const port = await startServer(context);
  const missing = researchDeclaration();
  delete missing.evidence_digest;
  const { status, body } = await postJson(port, "/declarations", missing);
  assert.equal(status, 422);
  assert.equal(body.error, "invalid_evidence_digest");

  const badLevel = await postJson(port, "/declarations", researchDeclaration({ confidentiality_level: "top_secret" }));
  assert.equal(badLevel.status, 422);
  assert.equal(badLevel.body.error, "invalid_confidentiality_level");
});

test("指标口径不一致的双方不能进入联合验证", async (context) => {
  const port = await startServer(context);
  const { researchId, demandId } = await submitPair(port, {}, { metric_revision: "v2" });
  const { status, body } = await postJson(port, "/verification-sessions", {
    research_declaration_id: researchId,
    demand_declaration_id: demandId,
  });
  assert.equal(status, 422);
  assert.equal(body.error, "metric_caliber_incompatible");
});

test("保密级别不一致的双方不能进入联合验证", async (context) => {
  const port = await startServer(context);
  const { researchId, demandId } = await submitPair(port, {}, { confidentiality_level: "restricted" });
  const { status, body } = await postJson(port, "/verification-sessions", {
    research_declaration_id: researchId,
    demand_declaration_id: demandId,
  });
  assert.equal(status, 422);
  assert.equal(body.error, "confidentiality_incompatible");
});

test("双方确认后会话激活，单方确认不够", async (context) => {
  const port = await startServer(context);
  const { researchId, demandId } = await submitPair(port);
  const created = await postJson(port, "/verification-sessions", {
    research_declaration_id: researchId,
    demand_declaration_id: demandId,
  });
  assert.equal(created.status, 201);
  const sessionId = created.body.session.id;
  assert.equal(created.body.session.status, "pending_confirmation");

  const first = await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "research" });
  assert.equal(first.body.session.status, "pending_confirmation");

  const second = await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "demand" });
  assert.equal(second.body.session.status, "active");
  assert.ok(second.body.session.activated_at);
});

test("合作方更换指标后须双方重新确认", async (context) => {
  const port = await startServer(context);
  const { researchId, demandId } = await submitPair(port);
  const created = await postJson(port, "/verification-sessions", {
    research_declaration_id: researchId,
    demand_declaration_id: demandId,
  });
  const sessionId = created.body.session.id;
  await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "research" });
  await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "demand" });

  const revised = await postJson(port, `/declarations/${researchId}/revisions`, { metric_revision: "v2" });
  assert.equal(revised.status, 200);
  assert.deepEqual(revised.body.reset_session_ids, [sessionId]);
  assert.equal(revised.body.declaration.metric_revision, "v2");

  const detail = await getJson(port, `/verification-sessions/${sessionId}`);
  assert.equal(detail.body.session.status, "pending_confirmation");
  assert.equal(detail.body.session.research_confirmed_at, null);
  assert.equal(detail.body.session.demand_confirmed_at, null);

  // 口径已变化，原确认作废；双方按新口径重新确认后才能激活。
  const reconfirm = await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "demand" });
  assert.equal(reconfirm.body.session.status, "pending_confirmation");
});

test("验证失败保留原始结论并明确归属", async (context) => {
  const port = await startServer(context);
  const { researchId, demandId } = await submitPair(port);
  const created = await postJson(port, "/verification-sessions", {
    research_declaration_id: researchId,
    demand_declaration_id: demandId,
  });
  const sessionId = created.body.session.id;
  await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "research" });
  await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "demand" });

  const recorded = await postJson(port, `/verification-sessions/${sessionId}/results`, {
    outcome: "failed",
    conclusion: "效率指标在约定工况下未达到声明值",
    attribution: "research",
  });
  assert.equal(recorded.status, 201);
  assert.equal(recorded.body.result.outcome, "failed");
  assert.equal(recorded.body.result.attribution, "research");

  // 结案后不能再写入结果，原始结论保持不变。
  const duplicate = await postJson(port, `/verification-sessions/${sessionId}/results`, {
    outcome: "passed",
    conclusion: "复测通过",
    attribution: "shared",
  });
  assert.equal(duplicate.status, 409);

  const detail = await getJson(port, `/verification-sessions/${sessionId}`);
  assert.equal(detail.body.session.status, "concluded");
  assert.equal(detail.body.results.length, 1);
  assert.equal(detail.body.results[0].conclusion, "效率指标在约定工况下未达到声明值");
  assert.equal(detail.body.results[0].attribution, "research");
});

test("试点转化前可区分实验数据支持与待验证意向", async (context) => {
  const port = await startServer(context);
  const { researchId, demandId } = await submitPair(port);
  const created = await postJson(port, "/verification-sessions", {
    research_declaration_id: researchId,
    demand_declaration_id: demandId,
  });
  const sessionId = created.body.session.id;
  await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "research" });
  await postJson(port, `/verification-sessions/${sessionId}/confirm`, { party_role: "demand" });
  await postJson(port, `/verification-sessions/${sessionId}/results`, {
    outcome: "passed",
    conclusion: "联合验证通过",
    attribution: "shared",
  });

  const { status, body } = await getJson(port, "/pilot-readiness?metric_code=storage_efficiency");
  assert.equal(status, 200);
  assert.equal(body.supported.length, 1);
  assert.equal(body.supported[0].id, researchId);
  assert.equal(body.supported[0].verification, "passed");
  assert.equal(body.intent.length, 1);
  assert.equal(body.intent[0].id, demandId);
  assert.equal(body.intent[0].verification, "passed");
});
