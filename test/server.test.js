
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../src/server");

async function startContext() {
  const databasePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "prm-test-")),
    "test.sqlite3"
  );
  const server = createServer(databasePath);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const stop = () =>
    new Promise((resolve) => server.close(() => fs.rmSync(path.dirname(databasePath), { recursive: true, force: true }) || resolve()));
  return { base, stop };
}

async function api(base, method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function seedParties(base) {
  await api(base, "POST", "/parties", { ref: "GRID-DEMO", role: "grid", name: "示例电网单位" });
  await api(base, "POST", "/parties", { ref: "TECH-DEMO", role: "research", name: "示例课题组" });
}

const DEMAND = {
  party_ref: "GRID-DEMO",
  demand_ref: "GRID-DEMAND-1",
  title: "储能电站循环效率验证场景",
  metric_code: "storage_efficiency",
  metric_revision: "GB/T-36558-2024",
  confidentiality: "consortium",
};

const CAPABILITY = {
  party_ref: "TECH-DEMO",
  capability_ref: "TECH-CAP-1",
  title: "储能系统综合效率优化技术",
  metric_code: "storage_efficiency",
  metric_revision: "GB/T-36558-2024",
  confidentiality: "public",
  evidence_kind: "experimental",
  evidence_digest: "sha256:demo-digest-0001",
  measured_value: "92.5%",
};

async function confirmedPairing(base) {
  await seedParties(base);
  await api(base, "POST", "/demands", DEMAND);
  await api(base, "POST", "/capabilities", CAPABILITY);
  const pairing = await api(base, "POST", "/pairings", {
    demand_ref: DEMAND.demand_ref,
    capability_ref: CAPABILITY.capability_ref,
  });
  const pairingId = pairing.json.id;
  await api(base, "POST", `/pairings/${pairingId}/confirmations`, { party_ref: "GRID-DEMO" });
  await api(base, "POST", `/pairings/${pairingId}/confirmations`, { party_ref: "TECH-DEMO" });
  return pairingId;
}

test("健康接口返回服务状态", async () => {
  const { base, stop } = await startContext();
  try {
    const { status, json } = await api(base, "GET", "/health");
    assert.equal(status, 200);
    assert.deepEqual(json, { status: "ok" });
  } finally {
    await stop();
  }
});

test("需求与能力声明按来源编号递增版本，旧版本被替代", async () => {
  const { base, stop } = await startContext();
  try {
    await seedParties(base);
    const v1 = await api(base, "POST", "/demands", DEMAND);
    const v2 = await api(base, "POST", "/demands", { ...DEMAND, title: "场景更新" });
    assert.equal(v1.json.version, 1);
    assert.equal(v2.json.version, 2);
    const detail = await api(base, "GET", `/demands/${DEMAND.demand_ref}`);
    assert.equal(detail.json.version, 2);
    assert.equal(detail.json.versions.length, 2);
    // 版本按倒序返回：新版本 active，旧版本 superseded。
    assert.deepEqual(
      detail.json.versions.map((row) => row.status),
      ["active", "superseded"]
    );
  } finally {
    await stop();
  }
});

test("指标代码、修订版本或保密级别不兼容时拒绝配对", async () => {
  const { base, stop } = await startContext();
  try {
    await seedParties(base);
    await api(base, "POST", "/demands", DEMAND);

    // 指标修订版本不一致：双方对“储能效率”使用不同口径。
    const revisionMismatch = await api(base, "POST", "/capabilities", {
      ...CAPABILITY,
      capability_ref: "CAP-REV",
      metric_revision: "IEC-62933-2020",
    });
    let rejected = await api(base, "POST", "/pairings", {
      demand_ref: DEMAND.demand_ref,
      capability_ref: "CAP-REV",
    });
    assert.equal(rejected.status, 422);
    assert.match(rejected.json.message, /metric_revision_mismatch/);

    // 指标代码不同同样拒绝。
    await api(base, "POST", "/capabilities", {
      ...CAPABILITY,
      capability_ref: "CAP-CODE",
      metric_code: "roundtrip_efficiency",
    });
    rejected = await api(base, "POST", "/pairings", {
      demand_ref: DEMAND.demand_ref,
      capability_ref: "CAP-CODE",
    });
    assert.equal(rejected.status, 422);
    assert.match(rejected.json.message, /metric_code_mismatch/);

    // 高敏证据不能放进比它公开范围更大的场景：bilateral 证据 → consortium 场景，拒绝。
    await api(base, "POST", "/capabilities", {
      ...CAPABILITY,
      capability_ref: "CAP-SECRET",
      confidentiality: "bilateral",
    });
    rejected = await api(base, "POST", "/pairings", {
      demand_ref: DEMAND.demand_ref,
      capability_ref: "CAP-SECRET",
    });
    assert.equal(rejected.status, 422);
    assert.match(rejected.json.message, /confidentiality_incompatible/);

    // 口径一致且证据公开范围窄于场景：允许配对。
    assert.equal(revisionMismatch.status, 201);
  } finally {
    await stop();
  }
});

test("只有双方分别确认后才能提交联合验证，单方确认无效", async () => {
  const { base, stop } = await startContext();
  try {
    await seedParties(base);
    await api(base, "POST", "/demands", DEMAND);
    await api(base, "POST", "/capabilities", CAPABILITY);
    const pairing = await api(base, "POST", "/pairings", {
      demand_ref: DEMAND.demand_ref,
      capability_ref: CAPABILITY.capability_ref,
    });
    const pairingId = pairing.json.id;

    let blocked = await api(base, "POST", `/pairings/${pairingId}/verifications`, {
      party_ref: "TECH-DEMO",
      result: "pass",
      conclusion: "未确认时不能验证",
    });
    assert.equal(blocked.status, 409);

    await api(base, "POST", `/pairings/${pairingId}/confirmations`, { party_ref: "GRID-DEMO" });
    const half = await api(base, "GET", `/pairings/${pairingId}`);
    assert.equal(half.json.status, "proposed");

    blocked = await api(base, "POST", `/pairings/${pairingId}/verifications`, {
      party_ref: "TECH-DEMO",
      result: "pass",
      conclusion: "单方确认仍不能验证",
    });
    assert.equal(blocked.status, 409);

    await api(base, "POST", `/pairings/${pairingId}/confirmations`, { party_ref: "TECH-DEMO" });
    const full = await api(base, "GET", `/pairings/${pairingId}`);
    assert.equal(full.json.status, "confirmed");

    const verified = await api(base, "POST", `/pairings/${pairingId}/verifications`, {
      party_ref: "TECH-DEMO",
      result: "pass",
      conclusion: "口径一致，效率达标",
    });
    assert.equal(verified.status, 201);
  } finally {
    await stop();
  }
});

test("合作方更换指标后配对失效，必须重新提议并经双方再确认", async () => {
  const { base, stop } = await startContext();
  try {
    const pairingId = await confirmedPairing(base);

    await api(base, "POST", "/capabilities", {
      ...CAPABILITY,
      metric_revision: "GB/T-36558-2025",
      evidence_digest: "sha256:demo-digest-0002",
    });
    const changed = await api(base, "GET", `/pairings/${pairingId}`);
    assert.equal(changed.json.status, "metric_changed");

    // 失效状态下直接确认被拒绝。
    const confirmRejected = await api(base, "POST", `/pairings/${pairingId}/confirmations`, {
      party_ref: "GRID-DEMO",
    });
    assert.equal(confirmRejected.status, 409);

    // 新版本若与需求口径不一致，重新提议也会被门禁拦住。
    const incompatible = await api(base, "POST", "/pairings", {
      demand_ref: DEMAND.demand_ref,
      capability_ref: CAPABILITY.capability_ref,
    });
    assert.equal(incompatible.status, 422);

    // 电网方按同一新口径更新需求后，重新提议并双方再确认。
    await api(base, "POST", "/demands", { ...DEMAND, metric_revision: "GB/T-36558-2025" });
    const reproposed = await api(base, "POST", "/pairings", {
      demand_ref: DEMAND.demand_ref,
      capability_ref: CAPABILITY.capability_ref,
    });
    assert.equal(reproposed.status, 201);
    assert.equal(reproposed.json.status, "proposed");
    assert.equal(reproposed.json.id, pairingId);
    assert.equal(reproposed.json.metric_revision_demand, "GB/T-36558-2025");
    await api(base, "POST", `/pairings/${pairingId}/confirmations`, { party_ref: "GRID-DEMO" });
    await api(base, "POST", `/pairings/${pairingId}/confirmations`, { party_ref: "TECH-DEMO" });
    const again = await api(base, "GET", `/pairings/${pairingId}`);
    assert.equal(again.json.status, "confirmed");
  } finally {
    await stop();
  }
});

test("验证失败保留原始结论并记录归属，后续通过不覆盖失败记录", async () => {
  const { base, stop } = await startContext();
  try {
    const pairingId = await confirmedPairing(base);

    const failed = await api(base, "POST", `/pairings/${pairingId}/verifications`, {
      party_ref: "GRID-DEMO",
      result: "fail",
      conclusion: "额定工况外效率低于约定阈值",
      evidence_ref: "lab-report-2026-09-01",
    });
    assert.equal(failed.json.owner_role, "grid");
    assert.equal(failed.json.result, "fail");
    // 结论固化了当时双方的指标修订版本与保密级别。
    assert.equal(failed.json.metric_revision_demand, DEMAND.metric_revision);
    assert.equal(failed.json.metric_revision_capability, CAPABILITY.metric_revision);

    const passed = await api(base, "POST", `/pairings/${pairingId}/verifications`, {
      party_ref: "TECH-DEMO",
      result: "pass",
      conclusion: "整改后在约定工况复测通过",
    });
    assert.equal(passed.json.owner_role, "research");

    const detail = await api(base, "GET", `/pairings/${pairingId}`);
    assert.equal(detail.json.verifications.length, 2);
    assert.deepEqual(
      detail.json.verifications.map((row) => row.result),
      ["fail", "pass"]
    );
    // 没有更新/删除接口：失败结论与归属仍可追溯。
    assert.equal(detail.json.verifications[0].conclusion, "额定工况外效率低于约定阈值");
  } finally {
    await stop();
  }
});

test("试点转化前能区分有实验数据支持的声明与仅待验证意向", async () => {
  const { base, stop } = await startContext();
  try {
    const pairingId = await confirmedPairing(base);

    // 另一条只有意向、尚无实验数据的声明。
    await api(base, "POST", "/capabilities", {
      ...CAPABILITY,
      capability_ref: "TECH-CAP-INTENT",
      title: "尚在规划的新型储能方案",
      evidence_kind: "intent",
      evidence_digest: undefined,
    });
    // 意向声明因保密与口径兼容也可配对，但转化就绪状态必须表明其“待验证”。
    const intentPairing = await api(base, "POST", "/pairings", {
      demand_ref: DEMAND.demand_ref,
      capability_ref: "TECH-CAP-INTENT",
    });
    assert.equal(intentPairing.status, 201);

    await api(base, "POST", `/pairings/${pairingId}/verifications`, {
      party_ref: "GRID-DEMO",
      result: "fail",
      conclusion: "首轮验证失败",
    });

    const report = await api(base, "GET", "/exchange/readiness");
    const byRef = Object.fromEntries(report.json.map((row) => [row.capability_ref, row]));
    assert.equal(byRef["TECH-CAP-1"].has_experimental_data, true);
    assert.equal(byRef["TECH-CAP-1"].readiness, "verification_failed");
    assert.equal(byRef["TECH-CAP-1"].latest_result_owner_role, "grid");
    assert.equal(byRef["TECH-CAP-INTENT"].has_experimental_data, false);
    assert.equal(byRef["TECH-CAP-INTENT"].readiness, "pending_evidence");

    const onlyIntent = await api(base, "GET", "/exchange/readiness?evidence_kind=intent");
    assert.deepEqual(onlyIntent.json.map((row) => row.capability_ref), ["TECH-CAP-INTENT"]);

    const onlyExperimental = await api(base, "GET", "/exchange/readiness?evidence_kind=experimental");
    assert.deepEqual(onlyExperimental.json.map((row) => row.capability_ref), ["TECH-CAP-1"]);
  } finally {
    await stop();
  }
});

test("实验型声明缺少证据摘要时被拒绝", async () => {
  const { base, stop } = await startContext();
  try {
    await seedParties(base);
    await api(base, "POST", "/demands", DEMAND);
    const response = await api(base, "POST", "/capabilities", {
      ...CAPABILITY,
      evidence_digest: undefined,
    });
    assert.equal(response.status, 400);
    assert.match(response.json.message, /evidence_digest/);
  } finally {
    await stop();
  }
});

test("指标更换后新版本的就绪状态不继承旧版本的验证结论，旧结论仍保留", async () => {
  const { base, stop } = await startContext();
  try {
    const pairingId = await confirmedPairing(base);

    // 旧口径下验证通过。
    const firstPass = await api(base, "POST", `/pairings/${pairingId}/verifications`, {
      party_ref: "TECH-DEMO",
      result: "pass",
      conclusion: "旧口径验证通过",
    });
    assert.equal(firstPass.status, 201);

    // 双方更换指标并按新口径重新配对确认。
    await api(base, "POST", "/capabilities", {
      ...CAPABILITY,
      metric_revision: "GB/T-36558-2025",
      evidence_digest: "sha256:demo-digest-0002",
    });
    await api(base, "POST", "/demands", { ...DEMAND, metric_revision: "GB/T-36558-2025" });
    await api(base, "POST", "/pairings", {
      demand_ref: DEMAND.demand_ref,
      capability_ref: CAPABILITY.capability_ref,
    });
    await api(base, "POST", `/pairings/${pairingId}/confirmations`, { party_ref: "GRID-DEMO" });
    await api(base, "POST", `/pairings/${pairingId}/confirmations`, { party_ref: "TECH-DEMO" });

    // 当前版本尚未在新口径下验证：不继承旧版本的 pass。
    const report = await api(base, "GET", `/exchange/readiness?capability_ref=${CAPABILITY.capability_ref}`);
    assert.equal(report.json.length, 1);
    assert.equal(report.json[0].version, 2);
    assert.equal(report.json[0].verification_total, 0);
    assert.equal(report.json[0].readiness, "unverified_experimental");

    // 旧结论仍作为历史完整保留在配对详情中。
    const detail = await api(base, "GET", `/pairings/${pairingId}`);
    assert.deepEqual(
      detail.json.verifications.map((row) => row.conclusion),
      ["旧口径验证通过"]
    );
    assert.equal(detail.json.verifications[0].metric_revision_capability, "GB/T-36558-2024");
  } finally {
    await stop();
  }
});

test("非配对双方不能确认或提交验证结论", async () => {
  const { base, stop } = await startContext();
  try {
    const pairingId = await confirmedPairing(base);
    await api(base, "POST", "/parties", { ref: "GRID-OTHER", role: "grid", name: "其他电网单位" });

    const confirmRejected = await api(base, "POST", `/pairings/${pairingId}/confirmations`, {
      party_ref: "GRID-OTHER",
    });
    assert.equal(confirmRejected.status, 403);

    const verifyRejected = await api(base, "POST", `/pairings/${pairingId}/verifications`, {
      party_ref: "GRID-OTHER",
      result: "pass",
      conclusion: "外部方不得提交",
    });
    assert.equal(verifyRejected.status, 403);
  } finally {
    await stop();
  }
});
