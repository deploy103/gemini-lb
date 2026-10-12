import {
  Store,
  GatewayError,
  type Account,
  type Credential,
  type Bucket,
  object,
} from "./store.js";

export type Upstreams = { api: string; codeAssist: string; token: string };
export const DEFAULT_UPSTREAMS: Upstreams = {
  api: "https://generativelanguage.googleapis.com",
  codeAssist: "https://cloudcode-pa.googleapis.com",
  token: "https://oauth2.googleapis.com/token",
};
export class UpstreamFailure extends Error {
  constructor(
    readonly code: number,
    readonly body: unknown,
    readonly retryAfter?: string,
  ) {
    super("Upstream request failed");
  }
}
export function retryable(code: number) {
  return [408, 429, 500, 502, 503, 504].includes(code);
}
export function delayFor(error: UpstreamFailure): number {
  let ms = 0;
  if (error.retryAfter) {
    const seconds = Number(error.retryAfter);
    ms = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(error.retryAfter) - Date.now();
  }
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const body = error.body as {
    error?: {
      details?: {
        "@type"?: string;
        retryDelay?: string;
        violations?: { quotaId?: string; quotaMetric?: string }[];
      }[];
    };
  };
  const details = Array.isArray(body?.error?.details)
    ? body.error.details.filter((d) => d && typeof d === "object")
    : [];
  for (const d of details) {
    if (
      typeof d["@type"] === "string" &&
      d["@type"].endsWith("RetryInfo") &&
      typeof d.retryDelay === "string" &&
      /^\d+(\.\d+)?s$/.test(d.retryDelay)
    )
      ms = Math.max(ms, Number(d.retryDelay.slice(0, -1)) * 1000);
  }
  if (ms > 0 && Number.isFinite(ms)) return Math.min(ms, 366 * 86400_000);
  const daily = details.some(
    (d) =>
      Array.isArray(d.violations) &&
      d.violations.some(
        (v) =>
          v &&
          typeof v === "object" &&
          /perday|daily/i.test(`${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`),
      ),
  );
  return daily ? 86400_000 : error.code === 429 ? 60_000 : 2000;
}
export class Upstream {
  private refreshing = new Map<string, Promise<string>>();
  constructor(
    readonly store: Store,
    readonly endpoints: Upstreams = DEFAULT_UPSTREAMS,
  ) {}
  private async refresh(a: Account, c: Credential): Promise<string> {
    if (!c.refresh_token || !c.client_id || !c.client_secret) {
      const latest = this.store.account(a.id);
      latest.state = "reauth_required";
      this.store.saveAccount(latest);
      throw new GatewayError(
        401,
        "OAuth expired; reimport credentials",
        "UNAUTHENTICATED",
      );
    }
    const res = await fetch(this.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: c.refresh_token,
        client_id: c.client_id,
        client_secret: c.client_secret,
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    let data: Record<string, unknown>;
    try {
      data = object(await jsonResponse(res, 1024 * 1024));
    } catch {
      throw new GatewayError(
        res.ok || res.status >= 500 ? 502 : 401,
        "Invalid OAuth token response",
        "UNAUTHENTICATED",
      );
    }
    if (!res.ok) {
      if (data.error === "invalid_grant" || data.error === "invalid_client") {
        const latest = this.store.account(a.id);
        latest.state = "reauth_required";
        this.store.saveAccount(latest);
      }
      throw new GatewayError(
        res.status >= 500 || res.status === 429 ? 503 : 401,
        "OAuth refresh failed; check credentials and Google account",
        res.status >= 500 || res.status === 429
          ? "UNAVAILABLE"
          : "UNAUTHENTICATED",
      );
    }
    if (
      typeof data.access_token !== "string" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new GatewayError(502, "Invalid OAuth token response", "INTERNAL");
    const merged: Credential = {
      ...c,
      access_token: data.access_token,
      expiry_date: Date.now() + data.expires_in * 1000,
    };
    if (typeof data.refresh_token === "string" && data.refresh_token)
      merged.refresh_token = data.refresh_token;
    this.store.saveCredentials(a.id, merged);
    return merged.access_token!;
  }
  async accessToken(a: Account): Promise<string> {
    const c = this.store.credentials(a.id);
    if (
      c.access_token &&
      c.expiry_date &&
      c.expiry_date > Date.now() + (c.refresh_token ? 60_000 : 0)
    )
      return c.access_token;
    // A single refresh owns credential persistence even if its initiating request disconnects.
    const pending = this.refreshing.get(a.id);
    if (pending) return pending;
    const promise = this.refresh(a, c);
    this.refreshing.set(a.id, promise);
    try {
      return await promise;
    } finally {
      this.refreshing.delete(a.id);
    }
  }
  async request(
    a: Account,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (a.kind === "api-key")
      headers["x-goog-api-key"] = this.store.credentials(a.id).api_key!;
    else headers.authorization = `Bearer ${await this.accessToken(a)}`;
    signal.throwIfAborted();
    return fetch(
      (a.kind === "api-key" ? this.endpoints.api : this.endpoints.codeAssist) +
        path,
      {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: "error",
      },
    );
  }
  async quota(a: Account): Promise<Account> {
    if (a.kind !== "oauth")
      throw new GatewayError(
        400,
        "API-key quota is unknown; use Google AI Studio",
        "INVALID_ARGUMENT",
      );
    const res = await this.request(
      a,
      "/v1internal:retrieveUserQuota",
      { project: a.project },
      AbortSignal.timeout(20_000),
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw new GatewayError(
        502,
        "Google quota retrieval failed",
        "UNAVAILABLE",
      );
    }
    const data = object(await jsonResponse(res, 2 * 1024 * 1024));
    if (!Array.isArray(data.buckets) || data.buckets.length > 500)
      throw new GatewayError(502, "Invalid quota response", "INTERNAL");
    const buckets: Bucket[] = data.buckets.map((value) => {
      const b = object(value),
        result: Bucket = {};
      for (const field of [
        "modelId",
        "remainingAmount",
        "resetTime",
        "tokenType",
      ] as const)
        if (typeof b[field] === "string")
          result[field] = b[field].slice(0, 256);
      if (
        typeof b.remainingFraction === "number" &&
        Number.isFinite(b.remainingFraction) &&
        b.remainingFraction >= 0 &&
        b.remainingFraction <= 1
      )
        result.remainingFraction = b.remainingFraction;
      return result;
    });
    // Reread operator state; do not overwrite a concurrent disable or credential reimport.
    const latest = this.store.account(a.id);
    latest.quota = { buckets };
    latest.quotaUpdatedAt = Date.now();
    this.store.saveAccount(latest);
    return latest;
  }
  async settleRefreshes() {
    await Promise.allSettled(this.refreshing.values());
  }
}

export async function jsonResponse(
  res: Response,
  limit = 32 * 1024 * 1024,
): Promise<unknown> {
  if (!res.body)
    throw new UpstreamFailure(502, {
      error: { message: "Empty upstream response" },
    });
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new UpstreamFailure(502, {
          error: { message: "Upstream response too large" },
        });
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamFailure(502, {
        error: { message: "Malformed upstream JSON" },
      });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function* events(res: Response): AsyncGenerator<unknown> {
  if (
    !res.body ||
    !res.headers.get("content-type")?.includes("text/event-stream")
  )
    throw new UpstreamFailure(502, {
      error: { message: "Expected upstream SSE" },
    });
  const reader = res.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    data: string[] = [],
    size = 0,
    count = 0;
  const parse = () => {
    const text = data.join("\n");
    data = [];
    size = 0;
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamFailure(502, {
        error: { message: "Malformed upstream SSE JSON" },
      });
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done
        ? decoder.decode()
        : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024)
        throw new UpstreamFailure(502, {
          error: { message: "Upstream SSE line too large" },
        });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) {
            count++;
            yield parse();
          }
        } else if (line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /, "");
          size += value.length;
          if (size > 2 * 1024 * 1024)
            throw new UpstreamFailure(502, {
              error: { message: "Upstream SSE event too large" },
            });
          data.push(value);
        }
      }
      if (chunk.done) {
        if (buffer || data.length || count === 0)
          throw new UpstreamFailure(502, {
            error: { message: "Incomplete upstream SSE stream" },
          });
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
