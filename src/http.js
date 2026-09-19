
const http = require("node:http");
const { URL } = require("node:url");
const { ValidationError, DomainError } = require("./domain");

function createRequestHandler(store) {
  return async function handler(request, response) {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const segments = path.split("/").filter(Boolean);

    try {
      if (request.method === "GET" && path === "/health") {
        return sendJson(response, 200, { status: "ok" });
      }

      if (request.method === "POST" && path === "/parties") {
        return sendJson(response, 201, store.registerParty(await readBody(request)));
      }

      if (request.method === "POST" && path === "/demands") {
        return sendJson(response, 201, store.submitDemand(await readBody(request)));
      }

      if (request.method === "POST" && path === "/capabilities") {
        return sendJson(response, 201, store.submitCapability(await readBody(request)));
      }

      if (request.method === "GET" && path === "/demands") {
        return sendJson(response, 200, store.listDemands());
      }

      if (request.method === "GET" && segments[0] === "demands" && segments[1]) {
        return sendJson(response, 200, store.getDemand(segments[1]));
      }

      if (request.method === "GET" && path === "/capabilities") {
        return sendJson(response, 200, store.listCapabilities(url.searchParams.get("evidence_kind")));
      }

      if (request.method === "GET" && segments[0] === "capabilities" && segments[1]) {
        return sendJson(response, 200, store.getCapability(segments[1]));
      }

      if (request.method === "POST" && path === "/pairings") {
        return sendJson(response, 201, store.proposePairing(await readBody(request)));
      }

      if (request.method === "GET" && path === "/pairings") {
        return sendJson(response, 200, store.listPairings());
      }

      if (request.method === "POST" && segments[0] === "pairings" && segments[2] === "confirmations") {
        const body = await readBody(request);
        return sendJson(response, 200, store.confirmPairing(segments[1], body.party_ref));
      }

      if (request.method === "POST" && segments[0] === "pairings" && segments[2] === "verifications") {
        const body = await readBody(request);
        return sendJson(
          response,
          201,
          store.addVerification({ pairing_id: segments[1], ...body })
        );
      }

      if (request.method === "GET" && segments[0] === "pairings" && segments[1] && !segments[2]) {
        return sendJson(response, 200, store.getPairing(segments[1]));
      }

      // 试点转化前的就绪审查：哪些声明有实验数据支持、哪些只是待验证意向。
      if (request.method === "GET" && path === "/exchange/readiness") {
        return sendJson(
          response,
          200,
          store.readinessReport({
            capability_ref: url.searchParams.get("capability_ref"),
            evidence_kind: url.searchParams.get("evidence_kind"),
          })
        );
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      return handleError(response, error);
    }
  };
}

function createServer(store) {
  return http.createServer(createRequestHandler(store));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("请求体必须是合法 JSON");
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function handleError(response, error) {
  if (error instanceof ValidationError || error instanceof DomainError) {
    return sendJson(response, error.statusCode, {
      error: error.name,
      message: error.message,
    });
  }
  // 兜底：不向前端泄漏内部细节，但在服务端日志保留现场。
  console.error(error);
  response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "internal_error", message: "服务内部错误" }));
}

module.exports = { createRequestHandler, createServer };
