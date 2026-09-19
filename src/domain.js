
// 保密级别：公开 < 联盟内共享 < 双边保密。
// 需求方提出的场景保密级别必须不低于能力声明的保密级别才能配对：
// 把更敏感的实验数据放进更封闭的场景是允许的，反之不允许。
const CONFIDENTIALITY_RANK = {
  public: 1,
  consortium: 2,
  bilateral: 3,
};

const CONFIDENTIALITY_LEVELS = Object.keys(CONFIDENTIALITY_RANK);

// 指标口径兼容：指标代码相同，且双方引用同一指标修订版本，
// 避免“同一储能效率问题、不同测试口径”在转化阶段才暴露。
function metricCompatible(demand, capability) {
  return (
    demand.metric_code === capability.metric_code &&
    demand.metric_revision === capability.metric_revision
  );
}

function confidentialityCompatible(demand, capability) {
  return (
    CONFIDENTIALITY_RANK[demand.confidentiality] >=
    CONFIDENTIALITY_RANK[capability.confidentiality]
  );
}

// 进入联合验证的唯一门禁：指标口径一致且保密级别兼容。
function evaluateCompatibility(demand, capability) {
  const reasons = [];
  if (demand.metric_code !== capability.metric_code) {
    reasons.push(
      `metric_code_mismatch:${demand.metric_code}<>${capability.metric_code}`
    );
  }
  if (demand.metric_revision !== capability.metric_revision) {
    reasons.push(
      `metric_revision_mismatch:${demand.metric_revision}<>${capability.metric_revision}`
    );
  }
  if (!confidentialityCompatible(demand, capability)) {
    reasons.push(
      `confidentiality_incompatible:${capability.confidentiality}_evidence_into_${demand.confidentiality}_scenario`
    );
  }
  return { compatible: reasons.length === 0, reasons };
}

function nowIso() {
  return new Date().toISOString();
}

function requireFields(body, fields) {
  const missing = fields.filter(
    (field) => body[field] === undefined || body[field] === null || body[field] === ""
  );
  if (missing.length > 0) {
    throw new ValidationError(`缺少必填字段：${missing.join(", ")}`);
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

class DomainError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
  }
}

module.exports = {
  CONFIDENTIALITY_RANK,
  CONFIDENTIALITY_LEVELS,
  metricCompatible,
  confidentialityCompatible,
  evaluateCompatibility,
  requireFields,
  ValidationError,
  DomainError,
  nowIso,
};
