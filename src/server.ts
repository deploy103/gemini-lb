import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import {
  Store,
  GatewayError,
  object,
  string,
  type Account,
  type RequestRecord,
} from "./store.js";
import { Pool } from "./pool.js";
import {
  Upstream,
  UpstreamFailure,
  delayFor,
  events,
  jsonResponse,
  retryable,
  type Upstreams,
} from "./upstream.js";

const envelope = (code: number, message: string, status = "INTERNAL") => ({
  error: { code, message, status },
});
function header(req: FastifyRequest, name: string): string {
  const v = req.headers[name];
  return typeof v === "string" ? v : "";
}
function bearer(req: FastifyRequest): string {
  return header(req, "authorization").replace(/^Bearer\s+/i, "");
}
function usage(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as {
    response?: unknown;
    usageMetadata?: { totalTokenCount?: number };
  };
  if (v.response) return usage(v.response);
  const n = v.usageMetadata?.totalTokenCount;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0
    ? n
    : undefined;
}
function eventError(value: unknown): UpstreamFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as { error?: { code?: unknown } }).error;
  if (!error) return undefined;
  return new UpstreamFailure(
    typeof error.code === "number" && error.code >= 400 && error.code <= 599
      ? error.code
      : 502,
    value,
  );
}
function write(
  reply: FastifyReply,
  data: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (reply.raw.write(data)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      reply.raw.off("drain", drain);
      reply.raw.off("close", close);
      signal.removeEventListener("abort", abort);
    };
    const drain = () => {
      cleanup();
      resolve();
    };
    const close = () => {
      cleanup();
      reject(new Error("Client disconnected"));
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    reply.raw.once("drain", drain);
    reply.raw.once("close", close);
    signal.addEventListener("abort", abort, { once: true });
  });
}
type Route = {
  kind: Account["kind"];
  model: string;
  method: string;
  path: string;
  stream: boolean;
  discovery: boolean;
};
function resolveRoute(req: FastifyRequest): Route {
  const url = new URL(req.url, "http://gateway");
  const path = url.pathname.replace(/\/$/, "");
  const native =
    /^\/(v1beta|v1)\/models(?:\/([a-zA-Z0-9._-]{1,128})(?::([a-zA-Z]+))?)?$/.exec(
      path,
    );
  if (native) {
    const [, version, model = "", method = "models"] = native;
    const discovery = method === "models";
    if (
      discovery
        ? req.method !== "GET"
        : req.method !== "POST" ||
          ![
            "generateContent",
            "streamGenerateContent",
            "countTokens",
            "embedContent",
            "batchEmbedContents",
          ].includes(method)
    )
      throw new GatewayError(501, "Unsupported Gemini route", "UNIMPLEMENTED");
    const stream = method === "streamGenerateContent";
    const query = new URLSearchParams();
    if (stream) {
      if (url.searchParams.get("alt") !== "sse")
        throw new GatewayError(
          400,
          "Streaming requires alt=sse",
          "INVALID_ARGUMENT",
        );
      query.set("alt", "sse");
    }
    for (const field of ["pageSize", "pageToken"])
      if (discovery && url.searchParams.has(field))
        query.set(field, url.searchParams.get(field)!);
    return {
      kind: "api-key",
      model,
      method,
      path: `/${version}/models${model ? `/${model}${discovery ? "" : `:${method}`}` : ""}${query.size ? `?${query}` : ""}`,
      stream,
      discovery,
    };
  }
  const ca = /^\/v1internal:([a-zA-Z]+)$/.exec(path);
  if (ca && req.method === "POST") {
    const method = ca[1]!;
    if (
      ![
        "generateContent",
        "streamGenerateContent",
        "countTokens",
        "loadCodeAssist",
        "retrieveUserQuota",
        "fetchAdminControls",
        "listExperiments",
        "recordCodeAssistMetrics",
      ].includes(method)
    )
      throw new GatewayError(
        501,
        "Unsupported Code Assist RPC; onboard with official Gemini CLI first",
        "UNIMPLEMENTED",
      );
    const b = object(req.body),
      request = b.request ? object(b.request) : {};
    const rawModel = b.model ?? request.model;
    const model =
      rawModel === undefined
        ? ""
        : string(rawModel, "model", 128).replace(/^models\//, "");
    if (model && !/^[a-zA-Z0-9._-]+$/.test(model))
      throw new GatewayError(400, "Invalid model", "INVALID_ARGUMENT");
    if (
      ["generateContent", "streamGenerateContent", "countTokens"].includes(
        method,
      ) &&
      !model
    )
      throw new GatewayError(400, "Model required", "INVALID_ARGUMENT");
    if (Array.isArray(b.enabled_credit_types) && b.enabled_credit_types.length)
      throw new GatewayError(
        400,
        "Paid-credit opt-in is unsupported",
        "INVALID_ARGUMENT",
      );
    const stream = method === "streamGenerateContent";
    if (stream && url.searchParams.get("alt") !== "sse")
      throw new GatewayError(
        400,
        "Streaming requires alt=sse",
        "INVALID_ARGUMENT",
      );
    return {
      kind: "oauth",
      model,
      method,
      path: path + (stream ? "?alt=sse" : ""),
      stream,
      discovery: false,
    };
  }
  throw new GatewayError(501, "Unsupported inference route", "UNIMPLEMENTED");
}

export async function createServer(
  store: Store,
  options: { upstreams?: Upstreams; timeoutMs?: number } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 0,
    forceCloseConnections: true,
  });
  const pool = new Pool(store),
    upstream = new Upstream(store, options.upstreams);
  const controllers = new Set<AbortController>();
  app.addHook("preClose", async () => {
    for (const c of controllers) c.abort("shutdown");
  });
  app.addHook("onClose", async () => {
    await upstream.settleRefreshes();
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "no-store");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (req.url.split("?")[0]?.startsWith("/admin")) {
      const origin = header(req, "origin");
      if (header(req, "sec-fetch-site") === "cross-site")
        throw new GatewayError(
          403,
          "Cross-origin administration denied",
          "PERMISSION_DENIED",
        );
      if (origin) {
        let valid = false;
        try {
          const u = new URL(origin);
          valid =
            ["https:", "http:"].includes(u.protocol) &&
            u.host === header(req, "host");
        } catch {
          /* reject malformed origin */
        }
        if (!valid)
          throw new GatewayError(
            403,
            "Cross-origin administration denied",
            "PERMISSION_DENIED",
          );
      }
      if (!store.admin(bearer(req)))
        throw new GatewayError(
          401,
          "Valid admin token required",
          "UNAUTHENTICATED",
        );
    }
    if (/^\/(v\d|upload)/.test(req.url))
      store.authenticate(
        header(req, "x-gemini-lb-key") ||
          header(req, "x-goog-api-key") ||
          bearer(req),
      );
  });
  app.setErrorHandler((error, _req, reply) => {
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    if (error instanceof GatewayError) {
      if (error.retryAfter)
        reply.header("retry-after", String(error.retryAfter));
      return reply
        .code(error.code)
        .send(envelope(error.code, error.message, error.status));
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    const code =
      statusCode && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    return reply
      .code(code)
      .send(
        envelope(
          code,
          code < 500 ? "Invalid request" : "Internal gateway error",
          code < 500 ? "INVALID_ARGUMENT" : "INTERNAL",
        ),
      );
  });
  app.get("/healthz", async () => ({ status: "ok", version: "0.1.0" }));
  for (const [path, file, contentType] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "application/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
  ]) {
    const contents = readFileSync(
      fileURLToPath(new URL(`../public/${file}`, import.meta.url)),
    );
    app.get(path!, async (_req, reply) =>
      reply.type(contentType!).send(contents),
    );
  }
  app.get("/admin/overview", async () => {
    const accounts = store.accounts().map((a) => pool.publicAccount(a)),
      requests = store.requests();
    return {
      accounts,
      requests,
      stats: {
        requests: requests.length,
        errors: requests.filter((r) => r.outcome !== "success").length,
        tokens: requests.reduce((n, r) => n + r.tokens, 0),
        inflight: accounts.reduce((n, a) => n + a.inflight, 0),
      },
    };
  });
  app.post("/admin/accounts", async (req, reply) =>
    reply.code(201).send(pool.publicAccount(store.addAccount(req.body))),
  );
  app.patch<{ Params: { id: string } }>("/admin/accounts/:id", async (req) =>
    pool.publicAccount(store.patchAccount(req.params.id, req.body)),
  );
  app.post<{ Params: { id: string } }>(
    "/admin/accounts/:id/credentials",
    async (req) => {
      if (pool.inflight(req.params.id))
        throw new GatewayError(
          409,
          "Wait for active account requests before reimporting",
        );
      await upstream.settleRefreshes();
      if (pool.inflight(req.params.id))
        throw new GatewayError(
          409,
          "Wait for active account requests before reimporting",
        );
      return pool.publicAccount(store.reimport(req.params.id, req.body));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/admin/accounts/:id/quota",
    async (req) =>
      pool.publicAccount(await upstream.quota(store.account(req.params.id))),
  );
  app.get("/admin/keys", async () => store.keys());
  app.post("/admin/keys", async (req, reply) =>
    reply.code(201).send(store.createKey(req.body)),
  );
  app.patch<{ Params: { id: string } }>("/admin/keys/:id", async (req) =>
    store.patchKey(req.params.id, req.body),
  );

  const proxy = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = store.authenticate(
      header(req, "x-gemini-lb-key") ||
        header(req, "x-goog-api-key") ||
        bearer(req),
    );
    const route = resolveRoute(req);
    if (route.method === "recordCodeAssistMetrics")
      return reply.code(204).send();
    const b = req.method === "POST" ? object(req.body) : undefined;
    const sessionRaw =
      header(req, "x-gemini-lb-session") ||
      (route.kind === "oauth" && b?.request
        ? object(b.request).session_id
        : undefined);
    const session = sessionRaw ? string(sessionRaw, "session", 512) : undefined;
    const existing = session ? store.session(key.id, session) : undefined;
    let pinned = header(req, "x-gemini-lb-account") || existing;
    if (pinned && existing && pinned !== existing)
      throw new GatewayError(
        409,
        "Account header conflicts with established session",
      );
    if (pool.resourceReference(b) && !pinned)
      throw new GatewayError(
        409,
        "Resource/signature references require explicit account or established session",
      );
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort("deadline"),
      options.timeoutMs ?? 120_000,
    );
    timer.unref();
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort("disconnect");
    };
    reply.raw.on("close", disconnect);
    const started = Date.now(),
      excluded = new Set<string>();
    const record: RequestRecord = {
      id: randomUUID(),
      accountId: null,
      model: route.model,
      method: route.method,
      status: 500,
      outcome: "failed",
      attempts: 0,
      tokens: 0,
      durationMs: 0,
      createdAt: started,
    };
    let visible = false,
      lastError: UpstreamFailure | undefined;
    try {
      while (record.attempts < 3) {
        controller.signal.throwIfAborted();
        let lease;
        try {
          lease = pool.acquire(key, route.kind, route.model, excluded, pinned);
        } catch (error) {
          if (lastError) throw lastError;
          throw error;
        }
        const { account, release } = lease;
        record.accountId = account.id;
        record.attempts++;
        excluded.add(account.id);
        if (session) {
          store.bind(key.id, session, account.id);
          pinned = account.id;
        }
        try {
          const body = b ? structuredClone(b) : undefined;
          if (body && route.model) {
            const embedded = [
              body.model,
              (body.generateContentRequest as { model?: unknown } | undefined)
                ?.model,
              (body.request as { model?: unknown } | undefined)?.model,
            ];
            if (Array.isArray(body.requests))
              for (const item of body.requests)
                embedded.push(object(item).model);
            if (
              embedded.some(
                (m) =>
                  m !== undefined &&
                  (typeof m !== "string" ||
                    m.replace(/^models\//, "") !== route.model),
              )
            )
              throw new GatewayError(
                400,
                "Embedded model conflicts with routed model",
                "INVALID_ARGUMENT",
              );
          }
          if (route.kind === "oauth" && body) {
            if (
              [
                "generateContent",
                "streamGenerateContent",
                "retrieveUserQuota",
              ].includes(route.method) ||
              "project" in body
            )
              body.project = account.project;
            if (route.method === "loadCodeAssist") {
              body.cloudaicompanionProject = account.project;
              body.metadata = {
                ...object(body.metadata ?? {}),
                duetProject: account.project,
              };
            }
            if (body.metadata && typeof body.metadata === "object")
              (body.metadata as Record<string, unknown>).duetProject =
                account.project;
          }
          const res = await upstream.request(
            account,
            route.path,
            body,
            controller.signal,
          );
          if (!res.ok) {
            let errorBody;
            try {
              errorBody = await jsonResponse(res, 2 * 1024 * 1024);
            } catch {
              errorBody = envelope(
                res.status,
                "Upstream rejected the request",
                "UNKNOWN",
              );
            }
            throw new UpstreamFailure(
              res.status,
              errorBody,
              res.headers.get("retry-after") ?? undefined,
            );
          }
          reply.header("x-gemini-lb-account", account.id);
          if (route.stream) {
            for await (const event of events(res)) {
              const error = eventError(event);
              if (error) throw error;
              const tokens = usage(event);
              if (tokens !== undefined) record.tokens = tokens;
              if (!visible) {
                reply.hijack();
                reply.raw.writeHead(200, {
                  ...reply.getHeaders(),
                  "content-type": "text/event-stream; charset=utf-8",
                  "x-accel-buffering": "no",
                } as OutgoingHttpHeaders);
                visible = true;
              }
              await write(
                reply,
                `data: ${JSON.stringify(event)}\n\n`,
                controller.signal,
              );
            }
            reply.raw.end();
          } else {
            let data = await jsonResponse(res);
            const error = eventError(data);
            if (error) throw error;
            if (route.method === "loadCodeAssist") {
              const load = object(data);
              if (
                !load.currentTier ||
                (load.cloudaicompanionProject &&
                  load.cloudaicompanionProject !== account.project)
              )
                throw new GatewayError(
                  409,
                  "Account/project not onboarded or mismatched; use official Gemini CLI and reimport resolved project",
                );
            }
            if (route.discovery && !route.model && account.models.length) {
              const catalog = object(data);
              if (Array.isArray(catalog.models))
                catalog.models = catalog.models.filter(
                  (m) =>
                    typeof m === "object" &&
                    m &&
                    account.models.includes(
                      String((m as { name?: unknown }).name).replace(
                        /^models\//,
                        "",
                      ),
                    ),
                );
              data = catalog;
            }
            record.tokens = usage(data) ?? 0;
            reply.code(200).send(data);
          }
          record.status = 200;
          record.outcome = "success";
          return;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const failure =
            error instanceof UpstreamFailure
              ? error
              : error instanceof GatewayError
                ? undefined
                : new UpstreamFailure(
                    502,
                    envelope(
                      502,
                      "Upstream connection or stream failed",
                      "UNAVAILABLE",
                    ),
                  );
          if (!failure) throw error;
          lastError = failure;
          if (retryable(failure.code)) {
            // Slot settlement must precede health updates and any next selection.
            release();
            store.cooldown(
              account.quotaScope,
              route.model || "*",
              Date.now() + delayFor(failure),
            );
          }
          if (failure.code === 401 && account.kind === "oauth") {
            const latest = store.account(account.id);
            latest.state = "reauth_required";
            store.saveAccount(latest);
          }
          if (visible || pinned || !retryable(failure.code)) throw failure;
        } finally {
          release();
        }
      }
      throw (
        lastError ??
        new GatewayError(503, "Retry budget exhausted", "UNAVAILABLE")
      );
    } catch (error) {
      record.status = controller.signal.aborted
        ? controller.signal.reason === "deadline"
          ? 504
          : controller.signal.reason === "disconnect"
            ? 499
            : 503
        : error instanceof UpstreamFailure || error instanceof GatewayError
          ? error.code
          : 502;
      record.outcome =
        controller.signal.aborted && controller.signal.reason !== "deadline"
          ? "cancelled"
          : visible
            ? "partial"
            : "failed";
      if (visible || reply.raw.destroyed) {
        reply.raw.destroy();
        return;
      }
      if (error instanceof UpstreamFailure) {
        if (retryable(error.code))
          reply.header(
            "retry-after",
            String(Math.max(1, Math.ceil(delayFor(error) / 1000))),
          );
        // Error text is provider-controlled; remove selected account credentials from it.
        const secrets = record.accountId
          ? Object.values(store.credentials(record.accountId)).filter(
              (s): s is string => typeof s === "string" && s.length >= 8,
            )
          : [];
        const source =
          error.body && typeof error.body === "object" && "error" in error.body
            ? error.body
            : envelope(error.code, "Upstream rejected the request", "UNKNOWN");
        const body = JSON.stringify(source, (_key, value) =>
          typeof value === "string"
            ? secrets.reduce(
                (s, secret) => s.split(secret).join("[redacted]"),
                value,
              )
            : value,
        );
        return reply.code(error.code).send(JSON.parse(body));
      }
      if (error instanceof GatewayError) throw error;
      return reply
        .code(record.status)
        .send(
          envelope(
            record.status,
            controller.signal.aborted
              ? controller.signal.reason === "deadline"
                ? "Request deadline exceeded"
                : "Gateway request cancelled"
              : "Upstream request failed",
            "UNAVAILABLE",
          ),
        );
    } finally {
      clearTimeout(timer);
      reply.raw.off("close", disconnect);
      controllers.delete(controller);
      record.durationMs = Date.now() - started;
      store.record(record);
    }
  };
  app.route({ method: ["GET", "POST"], url: "/v1beta/*", handler: proxy });
  app.route({ method: ["GET", "POST"], url: "/v1/*", handler: proxy });
  app.route({ method: ["GET", "POST"], url: "/v1internal*", handler: proxy });
  app.setNotFoundHandler(async (req, reply) => {
    if (/^\/(v\d|upload)/.test(req.url)) {
      store.authenticate(
        header(req, "x-gemini-lb-key") ||
          header(req, "x-goog-api-key") ||
          bearer(req),
      );
      throw new GatewayError(
        501,
        "Unsupported inference route",
        "UNIMPLEMENTED",
      );
    }
    return reply.code(404).send(envelope(404, "Not found", "NOT_FOUND"));
  });
  await app.ready();
  return { app, pool, upstream };
}
