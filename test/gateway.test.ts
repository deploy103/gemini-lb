import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer as httpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { GoogleGenAI } from "@google/genai";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";

type Call = { url: string; headers: IncomingMessage["headers"]; body: any };
type Handler = (call: Call, response: ServerResponse) => void | Promise<void>;
const content = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
const nativePath = "/v1beta/models/gemini-test:generateContent";
const streamPath = "/v1beta/models/gemini-test:streamGenerateContent?alt=sse";
const answer = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "안녕하세요" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { totalTokenCount: 17 },
};
function json(
  res: ServerResponse,
  value: unknown,
  code = 200,
  headers: Record<string, string> = {},
) {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}
function event(res: ServerResponse, value: unknown) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}
async function fixture(
  t: TestContext,
  handler: Handler = (_call, res) => json(res, answer),
  timeoutMs = 2000,
) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-lb-test-"));
  const store = new Store(dir, true),
    tokens = store.initialTokens!;
  const calls: Call[] = [];
  const upstream = httpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const call = {
      url: req.url!,
      headers: req.headers,
      body: raw
        ? req.headers["content-type"]?.startsWith("application/json")
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw))
        : undefined,
    };
    calls.push(call);
    try {
      await handler(call, res);
    } catch {
      if (!res.destroyed) res.destroy();
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const root = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let gateway = await createServer(store, {
    upstreams: { api: root, codeAssist: root, token: root + "/token" },
    timeoutMs,
  });
  let base = await gateway.app.listen({ host: "127.0.0.1", port: 0 });
  const admin = { authorization: `Bearer ${tokens.adminToken}` };
  const client = { "x-goog-api-key": tokens.clientKey };
  const fetchAt = async (
    path: string,
    body: unknown = content,
    headers: Record<string, string> = client,
    method = "POST",
  ) =>
    fetch(base + path, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined && method !== "GET"
          ? { "content-type": "application/json" }
          : {}),
      },
      body:
        body === undefined || method === "GET"
          ? undefined
          : JSON.stringify(body),
    });
  const add = async (
    name: string,
    project = name,
    kind = "api-key",
    credential: unknown = { api_key: `upstream-${name}` },
    extra = {},
  ) => {
    const res = await fetchAt(
      "/admin/accounts",
      { name, project, kind, credential, ...extra },
      admin,
    );
    assert.equal(res.status, 201, await res.clone().text());
    return res.json() as Promise<any>;
  };
  const overview = async () =>
    (
      await fetchAt("/admin/overview", undefined, admin, "GET")
    ).json() as Promise<any>;
  t.after(async () => {
    await gateway.app.close();
    store.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    tokens,
    calls,
    admin,
    client,
    add,
    fetchAt,
    overview,
    get base() {
      return base;
    },
    get gateway() {
      return gateway;
    },
    restart: async () => {
      await gateway.app.close();
      gateway = await createServer(store, {
        upstreams: { api: root, codeAssist: root, token: root + "/token" },
        timeoutMs,
      });
      base = await gateway.app.listen({ host: "127.0.0.1", port: 0 });
    },
  };
}

test("auth separates admin/client identities; rejects cross-origin and unsupported routes", async (t) => {
  const f = await fixture(t);
  await f.add("one");
  assert.equal((await f.fetchAt(nativePath, content, {})).status, 401);
  assert.equal((await f.fetchAt(nativePath, content, f.admin)).status, 401);
  assert.equal(
    (await f.fetchAt("/admin/overview", undefined, f.client, "GET")).status,
    401,
  );
  assert.equal(
    (
      await f.fetchAt(
        "/admin/overview",
        undefined,
        { ...f.admin, origin: "https://evil.example" },
        "GET",
      )
    ).status,
    403,
  );
  assert.equal((await f.fetchAt("/healthz", undefined, {}, "GET")).status, 200);
  assert.equal((await f.fetchAt("/v1beta/interactions")).status, 501);
  assert.equal((await f.fetchAt("/upload/v1beta/files")).status, 501);
  assert.equal(f.calls.length, 0);
});

test("native Google SDK round-trips nonstream, SSE, token count, models and tools", async (t) => {
  const signature = "opaque-signature";
  const rich = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "lookup",
                args: { city: "서울" },
                id: "a7",
              },
              thoughtSignature: signature,
            },
          ],
        },
      },
    ],
    usageMetadata: { totalTokenCount: 23 },
    modelVersion: "upstream-version",
    unknown: { preserved: true },
  };
  const f = await fixture(t, (call, res) => {
    if (call.url.includes("streamGenerateContent")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      event(res, rich);
      res.end();
    } else if (call.url.includes("countTokens")) json(res, { totalTokens: 31 });
    else if (call.url === "/v1beta/models")
      json(res, { models: [{ name: "models/gemini-test" }] });
    else json(res, rich);
  });
  const a = await f.add("sdk");
  const sdk = new GoogleGenAI({
    apiKey: f.tokens.clientKey,
    httpOptions: {
      baseUrl: f.base,
      apiVersion: "v1beta",
      headers: { "x-gemini-lb-session": "sdk-session" },
    },
  });
  const generated = await sdk.models.generateContent({
    model: "gemini-test",
    contents: content.contents,
    config: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              parametersJsonSchema: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          ],
        },
      ],
    },
  });
  assert.equal(
    generated.candidates![0]!.content!.parts![0]!.thoughtSignature,
    signature,
  );
  assert.equal(generated.functionCalls![0]!.args!.city, "서울");
  const chunks = [];
  for await (const chunk of await sdk.models.generateContentStream({
    model: "gemini-test",
    contents: content.contents,
  }))
    chunks.push(chunk);
  assert.equal(chunks[0]!.usageMetadata!.totalTokenCount, 23);
  assert.equal(
    (
      await sdk.models.countTokens({
        model: "gemini-test",
        contents: content.contents,
      })
    ).totalTokens,
    31,
  );
  const pager = await sdk.models.list();
  assert.equal(pager.page[0]!.name, "models/gemini-test");
  assert.equal(f.calls[0]!.headers["x-goog-api-key"], "upstream-sdk");
  assert.equal(f.calls[0]!.headers.authorization, undefined);
  assert.equal(
    f.calls[0]!.body.tools[0].functionDeclarations[0].name,
    "lookup",
  );
  const next = await f.fetchAt(
    nativePath,
    {
      contents: [
        { role: "model", parts: rich.candidates[0]!.content.parts },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "lookup", response: { found: true } } },
            { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
          ],
        },
      ],
    },
    { ...f.client, "x-gemini-lb-session": "sdk-session" },
  );
  assert.equal(next.status, 200);
  assert.equal(next.headers.get("x-gemini-lb-account"), a.id);
  assert.deepEqual(await next.json(), rich);
  assert.equal(
    f.calls.at(-1)!.body.contents[0].parts[0].thoughtSignature,
    signature,
  );
});

test("least-inflight tie routing rotates; 429 excludes all keys of same project", async (t) => {
  const f = await fixture(t, (call, res) =>
    call.headers["x-goog-api-key"] === "upstream-a"
      ? json(
          res,
          {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.RetryInfo",
                  retryDelay: "120s",
                },
              ],
            },
          },
          429,
        )
      : json(res, answer),
  );
  const a = await f.add("a", "shared");
  const b = await f.add("b", "shared");
  const c = await f.add("c", "other");
  const res = await f.fetchAt(nativePath);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gemini-lb-account"), c.id);
  assert.deepEqual(
    f.calls.map((c) => c.headers["x-goog-api-key"]),
    ["upstream-a", "upstream-c"],
  );
  const view = await f.overview();
  assert.equal(view.requests[0].attempts, 2);
  assert.equal(view.stats.inflight, 0);
  assert.equal(view.accounts.find((v: any) => v.id === a.id).state, "cooldown");
  assert.equal(view.accounts.find((v: any) => v.id === b.id).state, "cooldown");
  assert.ok(view.accounts[0].cooldownUntil > Date.now() + 119_000);
});

test("quota cooldown preserves explicit delays and fails conservatively for daily exhaustion", async (t) => {
  const cases = [
    {
      name: "invalid header with valid fractional RetryInfo",
      seconds: 7.5,
      header: "not-a-date",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: "7.5s",
        },
      ],
    },
    {
      name: "longer Retry-After wins",
      seconds: 20,
      header: "20",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: "7.5s",
        },
      ],
    },
    {
      name: "daily quota without reset evidence",
      seconds: 86400,
      header: undefined,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }],
        },
      ],
    },
  ];
  for (const c of cases)
    await t.test(c.name, async (sub) => {
      const f = await fixture(sub, (_call, res) =>
        json(
          res,
          {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              details: c.details,
            },
          },
          429,
          c.header ? { "retry-after": c.header } : {},
        ),
      );
      await f.add("limited");
      const before = Date.now();
      const first = await f.fetchAt(nativePath);
      assert.equal(first.status, 429);
      assert.equal(
        first.headers.get("retry-after"),
        String(Math.ceil(c.seconds)),
      );
      const until = (await f.overview()).accounts[0].cooldownUntil;
      assert.ok(until >= before + c.seconds * 1000);
      assert.ok(until <= Date.now() + c.seconds * 1000);
      const blocked = await f.fetchAt(nativePath);
      assert.equal(blocked.status, 503);
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);
      assert.equal(f.calls.length, 1);
    });
});

test("stateless requests rotate and failed attempts stop at three distinct accounts", async (t) => {
  let failures = false;
  const f = await fixture(t, (_call, res) =>
    failures
      ? json(res, { error: { code: 503, status: "UNAVAILABLE" } }, 503)
      : json(res, answer),
  );
  const ids = [];
  for (const n of ["a", "b", "c", "d"]) ids.push((await f.add(n)).id);
  for (const id of ids)
    assert.equal(
      (await f.fetchAt(nativePath)).headers.get("x-gemini-lb-account"),
      id,
    );
  failures = true;
  const result = await f.fetchAt(nativePath);
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("retry-after"), "2");
  assert.equal(f.calls.length, 7);
  assert.equal(
    new Set(f.calls.slice(4).map((c) => c.headers["x-goog-api-key"])).size,
    3,
  );
  assert.equal((await f.overview()).stats.inflight, 0);
});

test("401 HTML response never becomes retryable 502; 403 does not fail over", async (t) => {
  let code = 401;
  const f = await fixture(t, (_call, res) => {
    res.writeHead(code, { "content-type": "text/html" });
    res.end("<h1>Unauthorized</h1>");
  });
  await f.add("a");
  await f.add("b");
  assert.equal((await f.fetchAt(nativePath)).status, 401);
  assert.equal(f.calls.length, 1);
  code = 403;
  assert.equal((await f.fetchAt(nativePath)).status, 403);
  assert.equal(f.calls.length, 2);
});

test("sessions are client-scoped, persistent and never migrate on failure/disable", async (t) => {
  const f = await fixture(t);
  const a = await f.add("a");
  const b = await f.add("b");
  const headers = { ...f.client, "x-gemini-lb-session": "conversation" };
  assert.equal(
    (await f.fetchAt(nativePath, content, headers)).headers.get(
      "x-gemini-lb-account",
    ),
    a.id,
  );
  await f.restart();
  assert.equal(
    (await f.fetchAt(nativePath, content, headers)).headers.get(
      "x-gemini-lb-account",
    ),
    a.id,
  );
  assert.equal(
    (
      await f.fetchAt(nativePath, content, {
        ...headers,
        "x-gemini-lb-account": b.id,
      })
    ).status,
    409,
  );
  const keyRes = await f.fetchAt("/admin/keys", { name: "other" }, f.admin);
  const otherKey = (await keyRes.json()) as any;
  assert.equal(
    (
      await f.fetchAt(nativePath, content, {
        "x-goog-api-key": otherKey.key,
        "x-gemini-lb-session": "conversation",
      })
    ).headers.get("x-gemini-lb-account"),
    b.id,
  );
  await f.fetchAt(
    `/admin/accounts/${a.id}`,
    { enabled: false },
    f.admin,
    "PATCH",
  );
  const unavailable = await f.fetchAt(nativePath, content, headers);
  assert.equal(unavailable.status, 503);
  assert.equal(f.calls.length, 3);
});

test("resource and signature ownership requires explicit account or pre-established session", async (t) => {
  const f = await fixture(t);
  const a = await f.add("a");
  for (const extra of [
    { cachedContent: "cachedContents/abc" },
    {
      contents: [
        { parts: [{ fileData: { fileUri: "https://provider/files/abc" } }] },
      ],
    },
    { contents: [{ parts: [{ thoughtSignature: "signed-state" }] }] },
  ]) {
    const body = { ...content, ...extra };
    assert.equal((await f.fetchAt(nativePath, body)).status, 409);
    assert.equal(
      (
        await f.fetchAt(nativePath, body, {
          ...f.client,
          "x-gemini-lb-session": "new",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.fetchAt(nativePath, body, {
          ...f.client,
          "x-gemini-lb-account": a.id,
        })
      ).status,
      200,
    );
  }
  assert.equal(f.calls.length, 3);
});

test("scoped keys, model allowlist and embedded model cannot escape routing policy", async (t) => {
  const f = await fixture(t, (_c, res) =>
    json(res, {
      models: [{ name: "models/gemini-test" }, { name: "models/gemini-other" }],
    }),
  );
  const a = await f.add(
    "a",
    "a",
    "api-key",
    { api_key: "upstream-a" },
    { models: ["gemini-test"] },
  );
  const b = await f.add("b");
  const key = (await (
    await f.fetchAt(
      "/admin/keys",
      { name: "scoped", accounts: [a.id] },
      f.admin,
    )
  ).json()) as any;
  const headers = { "x-goog-api-key": key.key };
  assert.equal(
    (
      await f.fetchAt(nativePath, content, {
        ...headers,
        "x-gemini-lb-account": b.id,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.fetchAt(
        "/v1beta/models/gemini-other:generateContent",
        content,
        headers,
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await f.fetchAt(
        "/v1beta/models/gemini-test:batchEmbedContents",
        {
          requests: [
            { model: "models/gemini-other", content: content.contents[0] },
          ],
        },
        headers,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.fetchAt(
        "/v1beta/models/gemini-test:countTokens",
        {
          generateContentRequest: { model: "models/gemini-other", ...content },
        },
        headers,
      )
    ).status,
    400,
  );
  const catalog = (await (
    await f.fetchAt("/v1beta/models", undefined, headers, "GET")
  ).json()) as any;
  assert.deepEqual(catalog.models, [{ name: "models/gemini-test" }]);
  assert.equal(f.calls.length, 1);
  await f.fetchAt(
    `/admin/keys/${key.id}`,
    { enabled: false },
    f.admin,
    "PATCH",
  );
  assert.equal((await f.fetchAt(nativePath, content, headers)).status, 401);
});

test("arbitrarily split multiline CRLF SSE preserves Unicode and counts cumulative usage once", async (t) => {
  const first = { ...answer, usageMetadata: { totalTokenCount: 7 } },
    last = { ...answer, usageMetadata: { totalTokenCount: 19 } };
  const f = await fixture(t, async (_call, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const raw = Buffer.from(
      `: heartbeat\r\ndata: ${JSON.stringify(first).replace(',"usageMetadata"', ',\r\ndata: "usageMetadata"')}\r\n\r\ndata:${JSON.stringify(last)}\r\n\r\n`,
    );
    for (let i = 0; i < raw.length; i += 3) {
      res.write(raw.subarray(i, i + 3));
      await sleep(1);
    }
    res.end();
  });
  await f.add("a");
  const res = await f.fetchAt(streamPath);
  assert.equal(res.status, 200);
  const chunks = (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((v) => JSON.parse(v.slice(6)));
  assert.deepEqual(chunks, [first, last]);
  const view = await f.overview();
  assert.equal(view.stats.tokens, 19);
  assert.equal(view.stats.inflight, 0);
});

test("pre-output SSE quota error fails over; terminal error after output never replays", async (t) => {
  let partial = false;
  const failure = {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: "2s",
        },
      ],
    },
  };
  const f = await fixture(t, async (call, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (call.headers["x-goog-api-key"] === "upstream-a" && !partial)
      event(res, failure);
    else {
      event(res, answer);
      if (partial) {
        await sleep(30);
        event(res, failure);
      }
    }
    res.end();
  });
  await f.add("a");
  await f.add("b");
  assert.deepEqual(
    (await (await f.fetchAt(streamPath)).text())
      .split("\n\n")
      .filter(Boolean)
      .map((v) => JSON.parse(v.slice(6))),
    [answer],
  );
  assert.equal(f.calls.length, 2);
  partial = true;
  const res = await f.fetchAt(streamPath);
  const reader = res.body!.getReader();
  assert.ok((await reader.read()).value!.length);
  await assert.rejects(async () => {
    while (!(await reader.read()).done) {}
  });
  assert.equal(f.calls.length, 3);
  const view = await f.overview();
  assert.equal(view.requests[0].outcome, "partial");
  assert.equal(view.requests[0].attempts, 1);
  assert.equal(view.stats.inflight, 0);
});

test("empty/malformed/incomplete SSE is not silently successful", async (t) => {
  for (const value of ["", "data: not-json\n\n", 'data: {"candidates":[]}'])
    await t.test(value || "empty", async (sub) => {
      const f = await fixture(sub, (_call, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(value);
      });
      const a = await f.add("a");
      const res = await f.fetchAt(streamPath, content, {
        ...f.client,
        "x-gemini-lb-account": a.id,
      });
      assert.equal(res.status, 502);
      assert.equal((await f.overview()).stats.inflight, 0);
    });
});

test("disconnect cancels upstream and releases slot without health penalty", async (t) => {
  let closed = false;
  const f = await fixture(t, (_call, res) => {
    res.on("close", () => {
      closed = true;
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, answer);
  });
  const a = await f.add(
    "a",
    "a",
    "api-key",
    { api_key: "upstream-a" },
    { maxInflight: 1 },
  );
  const res = await f.fetchAt(streamPath);
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  for (let i = 0; i < 100 && !closed; i++) await sleep(10);
  assert.equal(closed, true);
  const view = await f.overview();
  assert.equal(view.stats.inflight, 0);
  assert.equal(view.requests[0].outcome, "cancelled");
  assert.equal(view.accounts.find((v: any) => v.id === a.id).state, "ready");
});

test("concurrency reservations happen before dispatch and deadline releases them", async (t) => {
  const f = await fixture(t, () => {}, 120);
  await f.add(
    "a",
    "a",
    "api-key",
    { api_key: "upstream-a" },
    { maxInflight: 1 },
  );
  const pending = f.fetchAt(nativePath);
  for (let i = 0; i < 50 && !f.calls.length; i++) await sleep(2);
  const busy = await f.fetchAt(nativePath);
  assert.equal(busy.status, 503);
  assert.equal(f.calls.length, 1);
  assert.equal((await pending).status, 504);
  const view = await f.overview();
  assert.equal(view.stats.inflight, 0);
  assert.equal(view.accounts[0].state, "ready");
});

test("server shutdown settles an active request before releasing database ownership", async (t) => {
  const f = await fixture(t, () => {}, 5000);
  await f.add("active");
  const pending = f.fetchAt(nativePath).catch(() => undefined);
  for (let i = 0; i < 100 && !f.calls.length; i++) await sleep(2);
  assert.equal(f.calls.length, 1);
  await f.gateway.app.close();
  assert.equal(f.store.requests().length, 1);
  assert.equal(f.store.requests()[0]!.outcome, "cancelled");
  await pending;
});

test("Code Assist uses account-owned project, custom client key and transparent envelopes", async (t) => {
  const caAnswer = {
    response: answer,
    traceId: "trace-23",
    remainingCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "100" }],
  };
  const f = await fixture(t, (call, res) => {
    if (call.url.includes("loadCodeAssist"))
      json(res, {
        currentTier: { id: "free-tier" },
        cloudaicompanionProject: call.body.cloudaicompanionProject,
      });
    else if (call.url.includes("countTokens")) json(res, { totalTokens: 41 });
    else if (call.url.includes("streamGenerateContent")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      event(res, caAnswer);
      res.end();
    } else json(res, caAnswer);
  });
  const a = await f.add("oauth-a", "managed-a", "oauth", {
    access_token: "google-access-a",
    expiry_date: Date.now() + 3600_000,
  });
  await f.add("oauth-b", "managed-b", "oauth", {
    access_token: "google-access-b",
    expiry_date: Date.now() + 3600_000,
  });
  const headers = {
    "x-gemini-lb-key": f.tokens.clientKey,
    authorization: "Bearer inbound-google-do-not-forward",
    "x-gemini-lb-session": "cli",
  };
  const load = await f.fetchAt(
    "/v1internal:loadCodeAssist",
    {
      cloudaicompanionProject: "untrusted",
      metadata: { duetProject: "untrusted" },
    },
    headers,
  );
  assert.equal(load.status, 200);
  assert.equal(load.headers.get("x-gemini-lb-account"), a.id);
  const body = {
    model: "gemini-test",
    project: "untrusted",
    user_prompt_id: "p23",
    request: {
      ...content,
      session_id: "native-cli-session",
      generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
    },
  };
  const res = await f.fetchAt("/v1internal:generateContent", body, headers);
  assert.deepEqual(await res.json(), caAnswer);
  assert.equal(f.calls[1]!.body.project, "managed-a");
  assert.deepEqual(f.calls[1]!.body.request, body.request);
  assert.equal(f.calls[1]!.headers.authorization, "Bearer google-access-a");
  assert.equal(f.calls[1]!.headers["x-gemini-lb-key"], undefined);
  const streamed = await f.fetchAt(
    "/v1internal:streamGenerateContent?alt=sse",
    body,
    headers,
  );
  assert.deepEqual(
    JSON.parse((await streamed.text()).split("\n\n")[0]!.slice(6)),
    caAnswer,
  );
  assert.equal(
    (
      (await (
        await f.fetchAt(
          "/v1internal:countTokens",
          {
            request: {
              model: "models/gemini-test",
              contents: content.contents,
            },
          },
          headers,
        )
      ).json()) as any
    ).totalTokens,
    41,
  );
  const before = f.calls.length;
  assert.equal(
    (await f.fetchAt("/v1internal:recordCodeAssistMetrics", {}, headers))
      .status,
    204,
  );
  assert.equal(f.calls.length, before);
  assert.equal(
    (
      await f.fetchAt(
        "/v1internal:generateContent",
        { ...body, enabled_credit_types: ["GOOGLE_ONE_AI"] },
        headers,
      )
    ).status,
    400,
  );
});

test("concurrent OAuth refresh happens once and preserves omitted refresh_token across restart", async (t) => {
  let refreshes = 0;
  const f = await fixture(t, async (call, res) => {
    if (call.url === "/token") {
      refreshes++;
      assert.equal(call.body.refresh_token, "refresh-test");
      await sleep(40);
      json(res, { access_token: "fresh-google-access", expires_in: 3600 });
    } else json(res, { response: answer, traceId: "trace" });
  });
  const a = await f.add("oauth", "managed", "oauth", {
    refresh_token: "refresh-test",
    client_id: "test-client",
    client_secret: "test-client-secret",
  });
  const body = { model: "gemini-test", request: content };
  const responses = await Promise.all([
    f.fetchAt("/v1internal:generateContent", body),
    f.fetchAt("/v1internal:generateContent", body),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.equal(refreshes, 1);
  assert.equal(f.store.credentials(a.id).refresh_token, "refresh-test");
  await f.restart();
  assert.equal(
    (await f.fetchAt("/v1internal:generateContent", body)).status,
    200,
  );
  assert.equal(refreshes, 1);
  assert.ok(
    f.calls
      .filter((c) => c.url !== "/token")
      .every((c) => c.headers.authorization === "Bearer fresh-google-access"),
  );
});

test("invalid_grant excludes account until reimport; OAuth cache without client registration is rejected", async (t) => {
  const f = await fixture(t, (call, res) =>
    call.url === "/token"
      ? json(res, { error: "invalid_grant" }, 400)
      : json(res, { response: answer }),
  );
  const missing = await f.fetchAt(
    "/admin/accounts",
    {
      name: "missing",
      kind: "oauth",
      project: "p",
      credential: { refresh_token: "refresh-without-client" },
    },
    f.admin,
  );
  assert.equal(missing.status, 400);
  const a = await f.add("oauth", "managed", "oauth", {
    refresh_token: "bad-refresh",
    client_id: "test-client",
    client_secret: "test-client-secret",
  });
  const body = { model: "gemini-test", request: content };
  assert.equal(
    (await f.fetchAt("/v1internal:generateContent", body)).status,
    401,
  );
  assert.equal((await f.overview()).accounts[0].state, "reauth_required");
  assert.equal(
    (await f.fetchAt("/v1internal:generateContent", body)).status,
    503,
  );
  assert.equal(f.calls.length, 1);
  const reimport = await f.fetchAt(
    `/admin/accounts/${a.id}/credentials`,
    {
      credential: {
        access_token: "reimported-access",
        expiry_date: Date.now() + 3600_000,
      },
    },
    f.admin,
  );
  assert.equal(reimport.status, 200);
  assert.equal(
    (await f.fetchAt("/v1internal:generateContent", body)).status,
    200,
  );
});

test("quota snapshots exclude exhausted matching models but not another model or elapsed reset", async (t) => {
  let reset = new Date(Date.now() + 3600_000).toISOString();
  const f = await fixture(t, (call, res) =>
    call.url.includes("retrieveUserQuota")
      ? json(res, {
          buckets: [
            { modelId: "gemini-test", remainingFraction: 0, resetTime: reset },
          ],
        })
      : json(res, { response: answer }),
  );
  const a = await f.add("oauth", "managed", "oauth", {
    access_token: "google-access",
    expiry_date: Date.now() + 3600_000,
  });
  assert.equal(
    (await f.fetchAt(`/admin/accounts/${a.id}/quota`, undefined, f.admin))
      .status,
    200,
  );
  assert.equal(
    (
      await f.fetchAt("/v1internal:generateContent", {
        model: "gemini-test",
        request: content,
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await f.fetchAt("/v1internal:generateContent", {
        model: "gemini-other",
        request: content,
      })
    ).status,
    200,
  );
  reset = new Date(Date.now() - 1000).toISOString();
  await f.fetchAt(`/admin/accounts/${a.id}/quota`, undefined, f.admin);
  assert.equal(
    (
      await f.fetchAt("/v1internal:generateContent", {
        model: "gemini-test",
        request: content,
      })
    ).status,
    200,
  );
});

test("credentials encrypted at rest; admin overview/history never include upstream bodies or secrets", async (t) => {
  const f = await fixture(t, (call, res) =>
    json(
      res,
      {
        error: {
          code: 400,
          message: `reject ${call.headers["x-goog-api-key"]}`,
        },
      },
      400,
    ),
  );
  const secret = "test-secret-unique-123";
  await f.add("secure", "p", "api-key", { api_key: secret });
  const res = await f.fetchAt(nativePath, {
    contents: [{ parts: [{ text: "private-prompt-unique" }] }],
  });
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes(secret));
  const view = await f.overview();
  const text = JSON.stringify(view);
  for (const value of [
    secret,
    "private-prompt-unique",
    f.tokens.adminToken,
    f.tokens.clientKey,
  ])
    assert.ok(!text.includes(value));
  for (const file of ["gateway.db", "gateway.db-wal"])
    assert.ok(!readFileSync(join(f.dir, file)).includes(Buffer.from(secret)));
  assert.equal(statSync(join(f.dir, "secrets.json")).mode & 0o777, 0o600);
  assert.equal(statSync(f.dir).mode & 0o777, 0o700);
  assert.throws(() => new Store(f.dir), /Another process/);
});

test("native equivalent v1 and trailing-slash routes and query key isolation", async (t) => {
  const f = await fixture(t);
  await f.add("a");
  const res = await f.fetchAt(
    "/v1/models/gemini-test:generateContent/?key=untrusted&arbitrary=drop",
    content,
    {
      ...f.client,
      cookie: "secret-cookie",
      authorization: "Bearer ignore-me",
      "x-custom": "ignore",
    },
  );
  assert.equal(res.status, 200);
  assert.equal(f.calls[0]!.url, "/v1/models/gemini-test:generateContent");
  assert.equal(f.calls[0]!.headers.cookie, undefined);
  assert.equal(f.calls[0]!.headers.authorization, undefined);
  assert.equal(f.calls[0]!.headers["x-custom"], undefined);
});
