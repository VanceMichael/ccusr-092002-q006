
const http = require("node:http");
const { openDatabase, applyMigrations } = require("./db");

const PARTY_ROLES = ["research", "demand"];
const EVIDENCE_KINDS = ["experimental_data", "intent"];
const CONFIDENTIALITY_LEVELS = ["public", "internal", "restricted"];
const RESULT_OUTCOMES = ["passed", "failed"];
const RESULT_ATTRIBUTIONS = ["research", "demand", "shared"];

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, "payload_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function requireString(body, field) {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(422, `invalid_${field}`);
  }
  return value;
}

function requireEnum(body, field, allowed) {
  const value = requireString(body, field);
  if (!allowed.includes(value)) {
    throw new HttpError(422, `invalid_${field}`);
  }
  return value;
}

function requireId(body, field) {
  const value = body[field];
  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(422, `invalid_${field}`);
  }
  return value;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(422, "invalid_id");
  }
  return id;
}

function getDeclaration(database, id) {
  return database.prepare("SELECT * FROM declarations WHERE id = ?").get(id);
}

function createDeclaration(database, body) {
  const declaration = {
    party_role: requireEnum(body, "party_role", PARTY_ROLES),
    party_ref: requireString(body, "party_ref"),
    metric_code: requireString(body, "metric_code"),
    metric_revision: requireString(body, "metric_revision"),
    evidence_digest: requireString(body, "evidence_digest"),
    evidence_kind: requireEnum(body, "evidence_kind", EVIDENCE_KINDS),
    confidentiality_level: requireEnum(body, "confidentiality_level", CONFIDENTIALITY_LEVELS),
    public_scope: requireString(body, "public_scope"),
    submitted_at: nowIso(),
  };
  const result = database
    .prepare(
      `INSERT INTO declarations
        (party_role, party_ref, metric_code, metric_revision, evidence_digest,
         evidence_kind, confidentiality_level, public_scope, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      declaration.party_role,
      declaration.party_ref,
      declaration.metric_code,
      declaration.metric_revision,
      declaration.evidence_digest,
      declaration.evidence_kind,
      declaration.confidentiality_level,
      declaration.public_scope,
      declaration.submitted_at
    );
  return getDeclaration(database, Number(result.lastInsertRowid));
}

function listDeclarations(database, query) {
  const clauses = [];
  const params = [];
  if (query.get("party_role")) {
    clauses.push("party_role = ?");
    params.push(query.get("party_role"));
  }
  if (query.get("metric_code")) {
    clauses.push("metric_code = ?");
    params.push(query.get("metric_code"));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return database.prepare(`SELECT * FROM declarations ${where} ORDER BY id`).all(...params);
}

function reviseDeclaration(database, id, body) {
  const current = getDeclaration(database, id);
  if (!current) {
    throw new HttpError(404, "declaration_not_found");
  }
  const next = {
    metric_code: body.metric_code === undefined ? current.metric_code : requireString(body, "metric_code"),
    metric_revision:
      body.metric_revision === undefined ? current.metric_revision : requireString(body, "metric_revision"),
    evidence_digest:
      body.evidence_digest === undefined ? current.evidence_digest : requireString(body, "evidence_digest"),
  };
  const unchanged =
    next.metric_code === current.metric_code &&
    next.metric_revision === current.metric_revision &&
    next.evidence_digest === current.evidence_digest;
  if (unchanged) {
    throw new HttpError(422, "no_metric_change");
  }
  const changedAt = nowIso();
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO declaration_revisions
          (declaration_id, previous_metric_code, previous_metric_revision,
           next_metric_code, next_metric_revision, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, current.metric_code, current.metric_revision, next.metric_code, next.metric_revision, changedAt);
    database
      .prepare("UPDATE declarations SET metric_code = ?, metric_revision = ?, evidence_digest = ? WHERE id = ?")
      .run(next.metric_code, next.metric_revision, next.evidence_digest, id);
    // 指标或证据变更后，未结案的联合验证回到待确认，双方须重新确认。
    const stale = database
      .prepare(
        `SELECT id FROM verification_sessions
         WHERE status IN ('pending_confirmation', 'active')
           AND (research_declaration_id = ? OR demand_declaration_id = ?)`
      )
      .all(id, id);
    database
      .prepare(
        `UPDATE verification_sessions
         SET status = 'pending_confirmation',
             research_confirmed_at = NULL,
             demand_confirmed_at = NULL,
             activated_at = NULL
         WHERE status IN ('pending_confirmation', 'active')
           AND (research_declaration_id = ? OR demand_declaration_id = ?)`
      )
      .run(id, id);
    database.exec("COMMIT");
    return { declaration: getDeclaration(database, id), reset_session_ids: stale.map((row) => row.id) };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getSession(database, id) {
  return database.prepare("SELECT * FROM verification_sessions WHERE id = ?").get(id);
}

function createSession(database, body) {
  const researchId = requireId(body, "research_declaration_id");
  const demandId = requireId(body, "demand_declaration_id");
  const research = getDeclaration(database, researchId);
  const demand = getDeclaration(database, demandId);
  if (!research || !demand) {
    throw new HttpError(404, "declaration_not_found");
  }
  if (research.party_role !== "research" || demand.party_role !== "demand") {
    throw new HttpError(422, "party_role_mismatch");
  }
  // 指标口径兼容：指标编码与版本均一致。
  if (research.metric_code !== demand.metric_code || research.metric_revision !== demand.metric_revision) {
    throw new HttpError(422, "metric_caliber_incompatible");
  }
  // 保密级别兼容：双方级别相同才能进入联合验证。
  if (research.confidentiality_level !== demand.confidentiality_level) {
    throw new HttpError(422, "confidentiality_incompatible");
  }
  const result = database
    .prepare(
      `INSERT INTO verification_sessions
        (research_declaration_id, demand_declaration_id, status, created_at)
       VALUES (?, ?, 'pending_confirmation', ?)`
    )
    .run(researchId, demandId, nowIso());
  return getSession(database, Number(result.lastInsertRowid));
}

function confirmSession(database, id, body) {
  const session = getSession(database, id);
  if (!session) {
    throw new HttpError(404, "session_not_found");
  }
  if (session.status !== "pending_confirmation") {
    throw new HttpError(409, "session_not_pending");
  }
  const role = requireEnum(body, "party_role", PARTY_ROLES);
  const column = role === "research" ? "research_confirmed_at" : "demand_confirmed_at";
  if (session[column] === null) {
    database.prepare(`UPDATE verification_sessions SET ${column} = ? WHERE id = ?`).run(nowIso(), id);
  }
  const updated = getSession(database, id);
  if (updated.research_confirmed_at !== null && updated.demand_confirmed_at !== null) {
    database
      .prepare("UPDATE verification_sessions SET status = 'active', activated_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }
  return getSession(database, id);
}

function recordResult(database, id, body) {
  const session = getSession(database, id);
  if (!session) {
    throw new HttpError(404, "session_not_found");
  }
  if (session.status !== "active") {
    throw new HttpError(409, "session_not_active");
  }
  const outcome = requireEnum(body, "outcome", RESULT_OUTCOMES);
  const conclusion = requireString(body, "conclusion");
  const attribution = requireEnum(body, "attribution", RESULT_ATTRIBUTIONS);
  const recordedAt = nowIso();
  database.exec("BEGIN");
  try {
    // 结果只追加不修改，失败结论与归属随记录永久保留。
    const result = database
      .prepare(
        `INSERT INTO verification_results (session_id, outcome, conclusion, attribution, recorded_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, outcome, conclusion, attribution, recordedAt);
    database.prepare("UPDATE verification_sessions SET status = 'concluded' WHERE id = ?").run(id);
    database.exec("COMMIT");
    return database.prepare("SELECT * FROM verification_results WHERE id = ?").get(Number(result.lastInsertRowid));
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getSessionDetail(database, id) {
  const session = getSession(database, id);
  if (!session) {
    throw new HttpError(404, "session_not_found");
  }
  return {
    session,
    research_declaration: getDeclaration(database, session.research_declaration_id),
    demand_declaration: getDeclaration(database, session.demand_declaration_id),
    results: database
      .prepare("SELECT * FROM verification_results WHERE session_id = ? ORDER BY id")
      .all(id),
  };
}

function pilotReadiness(database, query) {
  const clauses = [];
  const params = [];
  if (query.get("metric_code")) {
    clauses.push("metric_code = ?");
    params.push(query.get("metric_code"));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const declarations = database.prepare(`SELECT * FROM declarations ${where} ORDER BY id`).all(...params);
  const outcomeStatement = database.prepare(
    `SELECT r.outcome AS outcome
     FROM verification_results r
     JOIN verification_sessions s ON s.id = r.session_id
     WHERE s.research_declaration_id = ? OR s.demand_declaration_id = ?`
  );
  const supported = [];
  const intent = [];
  for (const declaration of declarations) {
    const outcomes = outcomeStatement.all(declaration.id, declaration.id).map((row) => row.outcome);
    const verification = outcomes.includes("passed")
      ? "passed"
      : outcomes.includes("failed")
        ? "failed"
        : "unverified";
    const item = {
      id: declaration.id,
      party_role: declaration.party_role,
      party_ref: declaration.party_ref,
      metric_code: declaration.metric_code,
      metric_revision: declaration.metric_revision,
      evidence_kind: declaration.evidence_kind,
      confidentiality_level: declaration.confidentiality_level,
      verification,
    };
    if (declaration.evidence_kind === "experimental_data") {
      supported.push(item);
    } else {
      intent.push(item);
    }
  }
  return { supported, intent };
}

function createServer(options = {}) {
  const database = options.database || openDatabase(options.databasePath);
  applyMigrations(database);
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);
      const method = request.method;

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (method === "POST" && url.pathname === "/declarations") {
        const declaration = createDeclaration(database, await readJsonBody(request));
        sendJson(response, 201, { declaration });
        return;
      }

      if (method === "GET" && url.pathname === "/declarations") {
        sendJson(response, 200, { declarations: listDeclarations(database, url.searchParams) });
        return;
      }

      if (method === "POST" && segments[0] === "declarations" && segments.length === 3 && segments[2] === "revisions") {
        const outcome = reviseDeclaration(database, parseId(segments[1]), await readJsonBody(request));
        sendJson(response, 200, outcome);
        return;
      }

      if (method === "POST" && url.pathname === "/verification-sessions") {
        const session = createSession(database, await readJsonBody(request));
        sendJson(response, 201, { session });
        return;
      }

      if (method === "GET" && segments[0] === "verification-sessions" && segments.length === 2) {
        sendJson(response, 200, getSessionDetail(database, parseId(segments[1])));
        return;
      }

      if (method === "POST" && segments[0] === "verification-sessions" && segments.length === 3 && segments[2] === "confirm") {
        const session = confirmSession(database, parseId(segments[1]), await readJsonBody(request));
        sendJson(response, 200, { session });
        return;
      }

      if (method === "POST" && segments[0] === "verification-sessions" && segments.length === 3 && segments[2] === "results") {
        const result = recordResult(database, parseId(segments[1]), await readJsonBody(request));
        sendJson(response, 201, { result });
        return;
      }

      if (method === "GET" && url.pathname === "/pilot-readiness") {
        sendJson(response, 200, pilotReadiness(database, url.searchParams));
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.code });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0");
}

module.exports = { createServer };
