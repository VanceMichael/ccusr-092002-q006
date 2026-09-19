
const crypto = require("node:crypto");
const {
  DomainError,
  ValidationError,
  evaluateCompatibility,
  nowIso,
  requireFields,
} = require("./domain");

function createStore(database) {
  const statements = prepareStatements(database);

  function registerParty({ ref, role, name }) {
    requireFields({ ref, role, name }, ["ref", "role", "name"]);
    if (!["grid", "research"].includes(role)) {
      throw new ValidationError("role 必须为 grid 或 research");
    }
    const existing = statements.partyByRef.get(ref);
    if (existing) {
      if (existing.role !== role || existing.name !== name) {
        throw new DomainError(`来源编号 ${ref} 已注册且信息不一致`, 409);
      }
      return existing;
    }
    const id = crypto.randomUUID();
    statements.insertParty.run(id, ref, role, name, nowIso());
    return statements.partyById.get(id);
  }

  // 需求征集：电网方按来源编号提交新版本，旧版本自动失效。
  function submitDemand(input) {
    requireFields(input, [
      "party_ref",
      "demand_ref",
      "title",
      "metric_code",
      "metric_revision",
      "confidentiality",
    ]);
    const party = requireParty(input.party_ref, "grid");
    const version = nextDemandVersion(input.demand_ref);
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    database.exec("BEGIN");
    try {
      statements.demandSupersede.run(input.demand_ref);
      statements.insertDemand.run(
        id,
        input.demand_ref,
        party.id,
        version,
        input.title,
        input.scenario ?? null,
        input.target ?? null,
        input.metric_code,
        input.metric_revision,
        input.confidentiality,
        createdAt
      );
      // 提交方更换指标口径或保密范围：既有配对的确认全部失效，须双方重新确认。
      statements.pairingMarkChanged.run(
        "metric_changed", nowIso(), input.demand_ref, input.demand_ref, null, null, "metric_changed"
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return statements.demandVersionById.get(id);
  }

  // 技术能力声明：课题组按来源编号提交带版本的指标证据，
  // evidence_kind 区分“有实验数据支持”与“仅待验证意向”。
  function submitCapability(input) {
    requireFields(input, [
      "party_ref",
      "capability_ref",
      "title",
      "metric_code",
      "metric_revision",
      "confidentiality",
      "evidence_kind",
    ]);
    const party = requireParty(input.party_ref, "research");
    if (!["experimental", "intent"].includes(input.evidence_kind)) {
      throw new ValidationError("evidence_kind 必须为 experimental 或 intent");
    }
    if (input.evidence_kind === "experimental" && !input.evidence_digest) {
      throw new ValidationError("experimental 声明必须提供 evidence_digest（实验数据摘要）");
    }
    const version = nextCapabilityVersion(input.capability_ref);
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    database.exec("BEGIN");
    try {
      statements.capabilitySupersede.run(input.capability_ref);
      statements.insertCapability.run(
        id,
        input.capability_ref,
        party.id,
        version,
        input.title,
        input.metric_code,
        input.metric_revision,
        input.confidentiality,
        input.evidence_kind,
        input.evidence_digest ?? null,
        input.measured_value ?? null,
        createdAt
      );
      statements.pairingMarkChanged.run(
        "metric_changed", nowIso(), null, null, input.capability_ref, input.capability_ref, "metric_changed"
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return statements.capabilityVersionById.get(id);
  }

  // 配对（或在指标变更后按当前版本重新提议）：口径与保密级别不兼容则拒绝。
  function proposePairing({ demand_ref, capability_ref }) {
    requireFields({ demand_ref, capability_ref }, ["demand_ref", "capability_ref"]);
    const demand = activeDemand(demand_ref);
    const capability = activeCapability(capability_ref);
    const check = evaluateCompatibility(demand, capability);
    if (!check.compatible) {
      throw new DomainError(
        `指标口径或保密级别不兼容，不能进入联合验证：${check.reasons.join("；")}`,
        422
      );
    }
    const now = nowIso();
    const existing = statements.pairingByRefs.get(demand_ref, capability_ref);

    database.exec("BEGIN");
    try {
      let pairing;
      if (existing) {
        statements.pairingResnapshot.run(
          demand.id,
          capability.id,
          demand.metric_code,
          demand.metric_revision,
          demand.confidentiality,
          capability.metric_code,
          capability.metric_revision,
          capability.confidentiality,
          now,
          existing.id
        );
        pairing = statements.pairingById.get(existing.id);
      } else {
        const id = crypto.randomUUID();
        statements.insertPairing.run(
          id,
          demand_ref,
          capability_ref,
          demand.id,
          capability.id,
          demand.party_id,
          capability.party_id,
          demand.metric_code,
          demand.metric_revision,
          demand.confidentiality,
          capability.metric_code,
          capability.metric_revision,
          capability.confidentiality,
          now,
          now
        );
        pairing = statements.pairingById.get(id);
      }
      database.exec("COMMIT");
      return pairing;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  // 双方分别确认；确认绑定当前指标快照。任一方更换指标后须重新提议并双方再确认。
  function confirmPairing(pairingId, partyRef) {
    requireFields({ partyRef }, ["partyRef"]);
    const pairing = requirePairing(pairingId);
    const party = requireExistingParty(partyRef);
    if (party.id !== pairing.grid_party_id && party.id !== pairing.research_party_id) {
      throw new DomainError("只有配对双方可以确认", 403);
    }
    if (pairing.status === "metric_changed") {
      throw new DomainError("指标已变更，请按新版本重新提议配对后再确认", 409);
    }
    const now = nowIso();
    if (party.id === pairing.grid_party_id) {
      statements.pairingGridConfirm.run(now, now, pairingId);
    } else {
      statements.pairingResearchConfirm.run(now, now, pairingId);
    }
    const updated = statements.pairingById.get(pairingId);
    if (updated.grid_confirmed_at && updated.research_confirmed_at && updated.status === "proposed") {
      statements.pairingFullyConfirm.run(now, now, pairingId);
    }
    return statements.pairingById.get(pairingId);
  }

  // 联合验证结论只追加：失败结论与归属永久保留，不覆盖、不删除。
  function addVerification(input) {
    requireFields(input, ["pairing_id", "party_ref", "result", "conclusion"]);
    const pairing = requirePairing(input.pairing_id);
    const party = requireExistingParty(input.party_ref);
    if (party.id !== pairing.grid_party_id && party.id !== pairing.research_party_id) {
      throw new DomainError("只有配对双方可以提交联合验证结论", 403);
    }
    if (!["pass", "fail", "inconclusive"].includes(input.result)) {
      throw new ValidationError("result 必须为 pass、fail 或 inconclusive");
    }
    if (pairing.status !== "confirmed") {
      throw new DomainError(
        "配对尚未完成双方确认（或指标已变更），不能进入联合验证",
        409
      );
    }
    const ownerRole = party.id === pairing.grid_party_id ? "grid" : "research";
    const capability = statements.capabilityVersionById.get(pairing.capability_version_id);
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const snapshot = JSON.stringify({
      pairing_id: pairing.id,
      demand_ref: pairing.demand_ref,
      capability_ref: pairing.capability_ref,
      demand_version_id: pairing.demand_version_id,
      capability_version_id: pairing.capability_version_id,
      captured_at: createdAt,
    });
    statements.insertVerification.run(
      id,
      pairing.id,
      pairing.demand_version_id,
      pairing.capability_version_id,
      party.id,
      ownerRole,
      input.result,
      input.conclusion,
      input.evidence_ref ?? null,
      capability.evidence_kind,
      capability.evidence_digest,
      pairing.metric_code_demand,
      pairing.metric_revision_demand,
      pairing.metric_revision_capability,
      pairing.confidentiality_demand,
      pairing.confidentiality_capability,
      snapshot,
      createdAt
    );
    return statements.verificationById.get(id);
  }

  function listDemands() {
    return statements.activeDemands.all();
  }

  function listCapabilities(evidenceKind) {
    if (evidenceKind) {
      if (!["experimental", "intent"].includes(evidenceKind)) {
        throw new ValidationError("evidence_kind 过滤值必须为 experimental 或 intent");
      }
      return statements.activeCapabilitiesByKind.all(evidenceKind);
    }
    return statements.activeCapabilities.all();
  }

  function getDemand(ref) {
    const active = activeDemand(ref);
    const versions = statements.demandVersionsByRef.all(ref);
    return { ...active, versions };
  }

  function getCapability(ref) {
    const active = activeCapability(ref);
    const versions = statements.capabilityVersionsByRef.all(ref);
    return { ...active, versions };
  }

  function listPairings() {
    return statements.allPairings.all();
  }

  function getPairing(id) {
    const pairing = requirePairing(id);
    const verifications = statements.verificationsByPairing.all(id);
    return { ...pairing, verifications };
  }

  // 试点转化就绪审查：区分有实验数据支持的声明与仅为待验证意向的声明，
  // 并附上各自最新的联合验证结论（失败结论同样保留可查）。
  function readinessReport({ capability_ref, evidence_kind } = {}) {
    let rows;
    if (capability_ref) {
      rows = statements.readinessForCapability.all(capability_ref);
    } else if (evidence_kind) {
      if (!["experimental", "intent"].includes(evidence_kind)) {
        throw new ValidationError("evidence_kind 过滤值必须为 experimental 或 intent");
      }
      rows = statements.readinessByKind.all(evidence_kind);
    } else {
      rows = statements.readinessAll.all();
    }
    return rows.map((row) => ({
      capability_ref: row.capability_ref,
      version: row.version,
      title: row.title,
      metric_code: row.metric_code,
      metric_revision: row.metric_revision,
      confidentiality: row.confidentiality,
      evidence_kind: row.evidence_kind,
      evidence_digest: row.evidence_digest,
      has_experimental_data: row.evidence_kind === "experimental",
      verification_total: row.verification_total,
      latest_result: row.latest_result,
      latest_conclusion: row.latest_conclusion,
      latest_result_owner_role: row.latest_result_owner_role,
      latest_result_at: row.latest_result_at,
      readiness: classifyReadiness(row),
    }));
  }

  function requireParty(ref, expectedRole) {
    const party = statements.partyByRef.get(ref);
    if (!party) {
      throw new DomainError(`未注册的来源编号：${ref}`, 404);
    }
    if (expectedRole && party.role !== expectedRole) {
      throw new DomainError(
        `来源编号 ${ref} 的角色为 ${party.role}，此接口要求 ${expectedRole}`,
        403
      );
    }
    return party;
  }

  function requireExistingParty(ref) {
    return requireParty(ref);
  }

  function activeDemand(ref) {
    const demand = statements.activeDemandByRef.get(ref);
    if (!demand) {
      throw new DomainError(`需求 ${ref} 不存在或没有有效版本`, 404);
    }
    return demand;
  }

  function activeCapability(ref) {
    const capability = statements.activeCapabilityByRef.get(ref);
    if (!capability) {
      throw new DomainError(`能力声明 ${ref} 不存在或没有有效版本`, 404);
    }
    return capability;
  }

  function nextDemandVersion(ref) {
    const row = statements.maxDemandVersion.get(ref);
    return (row.version ?? 0) + 1;
  }

  function nextCapabilityVersion(ref) {
    const row = statements.maxCapabilityVersion.get(ref);
    return (row.version ?? 0) + 1;
  }

  function requirePairing(id) {
    const pairing = statements.pairingById.get(id);
    if (!pairing) {
      throw new DomainError(`配对 ${id} 不存在`, 404);
    }
    return pairing;
  }

  return {
    registerParty,
    submitDemand,
    submitCapability,
    proposePairing,
    confirmPairing,
    addVerification,
    listDemands,
    listCapabilities,
    getDemand,
    getCapability,
    listPairings,
    getPairing,
    readinessReport,
  };
}

// 转化就绪判定：
// 无验证且仅意向 => pending_evidence（待验证意向）
// 无验证但有实验数据 => unverified_experimental（有数据但未经联合验证）
// 有验证按最新结论：通过 / 失败 / 结论不充分
function classifyReadiness(row) {
  if (row.verification_total === 0) {
    return row.evidence_kind === "experimental"
      ? "unverified_experimental"
      : "pending_evidence";
  }
  if (row.latest_result === "pass") return "verified_pass";
  if (row.latest_result === "fail") return "verification_failed";
  return "verification_inconclusive";
}

// 就绪统计只计当前版本的验证结论：每条验证固化了产生它时的 capability_version_id，
// 配对重新提议（快照更新）不影响历史结论的归属。历史结论仍保留在配对详情中可查。
function readinessSql(whereClause) {
  return `
    SELECT
      c.capability_ref, c.version, c.title, c.metric_code, c.metric_revision,
      c.confidentiality, c.evidence_kind, c.evidence_digest,
      (SELECT COUNT(v3.id) FROM verifications v3
        WHERE v3.capability_version_id = c.id) AS verification_total,
      lv.result AS latest_result,
      lv.conclusion AS latest_conclusion,
      lv.owner_role AS latest_result_owner_role,
      lv.created_at AS latest_result_at
    FROM capability_versions c
    LEFT JOIN verifications lv
      ON lv.capability_version_id = c.id
     AND lv.rowid = (
        SELECT v5.rowid FROM verifications v5
        WHERE v5.capability_version_id = c.id
        ORDER BY v5.created_at DESC, v5.rowid DESC
        LIMIT 1
      )
    WHERE c.status = 'active' ${whereClause}
    ORDER BY c.created_at
  `;
}

function prepareStatements(database) {
  return {
    partyByRef: database.prepare("SELECT * FROM parties WHERE ref = ?"),
    partyById: database.prepare("SELECT * FROM parties WHERE id = ?"),
    insertParty: database.prepare(
      "INSERT INTO parties (id, ref, role, name, created_at) VALUES (?, ?, ?, ?, ?)"
    ),

    insertDemand: database.prepare(`
      INSERT INTO demand_versions
        (id, demand_ref, party_id, version, title, scenario, target,
         metric_code, metric_revision, confidentiality, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    demandSupersede: database.prepare(
      "UPDATE demand_versions SET status = 'superseded' WHERE demand_ref = ? AND status = 'active'"
    ),
    activeDemandByRef: database.prepare(
      "SELECT * FROM demand_versions WHERE demand_ref = ? AND status = 'active'"
    ),
    demandVersionById: database.prepare("SELECT * FROM demand_versions WHERE id = ?"),
    demandVersionsByRef: database.prepare(
      "SELECT * FROM demand_versions WHERE demand_ref = ? ORDER BY version DESC"
    ),
    maxDemandVersion: database.prepare(
      "SELECT MAX(version) AS version FROM demand_versions WHERE demand_ref = ?"
    ),
    activeDemands: database.prepare(
      "SELECT * FROM demand_versions WHERE status = 'active' ORDER BY created_at"
    ),

    insertCapability: database.prepare(`
      INSERT INTO capability_versions
        (id, capability_ref, party_id, version, title, metric_code, metric_revision,
         confidentiality, evidence_kind, evidence_digest, measured_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    capabilitySupersede: database.prepare(
      "UPDATE capability_versions SET status = 'superseded' WHERE capability_ref = ? AND status = 'active'"
    ),
    activeCapabilityByRef: database.prepare(
      "SELECT * FROM capability_versions WHERE capability_ref = ? AND status = 'active'"
    ),
    capabilityVersionById: database.prepare("SELECT * FROM capability_versions WHERE id = ?"),
    capabilityVersionsByRef: database.prepare(
      "SELECT * FROM capability_versions WHERE capability_ref = ? ORDER BY version DESC"
    ),
    maxCapabilityVersion: database.prepare(
      "SELECT MAX(version) AS version FROM capability_versions WHERE capability_ref = ?"
    ),
    activeCapabilities: database.prepare(
      "SELECT * FROM capability_versions WHERE status = 'active' ORDER BY created_at"
    ),
    activeCapabilitiesByKind: database.prepare(
      "SELECT * FROM capability_versions WHERE status = 'active' AND evidence_kind = ? ORDER BY created_at"
    ),

    pairingByRefs: database.prepare(
      "SELECT * FROM pairings WHERE demand_ref = ? AND capability_ref = ?"
    ),
    pairingById: database.prepare("SELECT * FROM pairings WHERE id = ?"),
    allPairings: database.prepare("SELECT * FROM pairings ORDER BY created_at"),
    insertPairing: database.prepare(`
      INSERT INTO pairings
        (id, demand_ref, capability_ref, demand_version_id, capability_version_id,
         grid_party_id, research_party_id, metric_code_demand, metric_revision_demand,
         confidentiality_demand, metric_code_capability, metric_revision_capability,
         confidentiality_capability, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    pairingResnapshot: database.prepare(`
      UPDATE pairings SET
        demand_version_id = ?, capability_version_id = ?,
        metric_code_demand = ?, metric_revision_demand = ?, confidentiality_demand = ?,
        metric_code_capability = ?, metric_revision_capability = ?, confidentiality_capability = ?,
        status = 'proposed',
        grid_confirmed_at = NULL, research_confirmed_at = NULL, confirmed_at = NULL,
        updated_at = ?
      WHERE id = ?
    `),
    pairingGridConfirm: database.prepare(
      "UPDATE pairings SET grid_confirmed_at = ?, updated_at = ? WHERE id = ?"
    ),
    pairingResearchConfirm: database.prepare(
      "UPDATE pairings SET research_confirmed_at = ?, updated_at = ? WHERE id = ?"
    ),
    pairingFullyConfirm: database.prepare(
      "UPDATE pairings SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?"
    ),
    // 任一方提交新版本（更换指标）都会让相关配对回到 metric_changed，等待重新提议与确认。
    pairingMarkChanged: database.prepare(`
      UPDATE pairings
      SET status = ?,
          grid_confirmed_at = NULL, research_confirmed_at = NULL, confirmed_at = NULL,
          updated_at = ?
      WHERE (? IS NULL OR demand_ref = ?)
        AND (? IS NULL OR capability_ref = ?)
        AND status != ?
    `),

    insertVerification: database.prepare(`
      INSERT INTO verifications
        (id, pairing_id, demand_version_id, capability_version_id,
         owner_party_id, owner_role, result, conclusion, evidence_ref,
         capability_evidence_kind, capability_evidence_digest, metric_code,
         metric_revision_demand, metric_revision_capability, confidentiality_demand,
         confidentiality_capability, snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    verificationById: database.prepare("SELECT * FROM verifications WHERE id = ?"),
    verificationsByPairing: database.prepare(
      "SELECT * FROM verifications WHERE pairing_id = ? ORDER BY created_at, rowid"
    ),

    readinessAll: database.prepare(readinessSql("")),
    readinessForCapability: database.prepare(
      readinessSql("AND c.capability_ref = ?")
    ),
    readinessByKind: database.prepare(readinessSql("AND c.evidence_kind = ?")),
  };
}

module.exports = { createStore, classifyReadiness };
