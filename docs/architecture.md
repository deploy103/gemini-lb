# Architecture — 0.1

Single-process Node 24 / TypeScript / Fastify gateway, with SQLite WAL persistence. The normative interface is [contract.md](contract.md); this document describes that design, not evidence of live Google compatibility.

```text
client -> authentication -> route family / affinity / scope
       -> reserve eligible account -> upstream request -> JSON or SSE
                                      |                 |
                                      v                 v
                                cooldown / refresh   client backpressure
                                      `-> metadata history / release slot
operator -> separate admin auth -> same-origin dashboard / SQLite
```

## Identity and persistence

Upstream account credentials, downstream client keys, and the operator admin token are separate identities. Credentials use AES-256-GCM with random nonces and account-ID additional authenticated data. Client keys are hashed in SQLite. `secrets.json` contains the master key and hashed admin token. Sessions persist for 24 hours, keyed by a hash of session identifier and client-key ID. A filesystem lock prevents two servers sharing one data directory; initialization and offline account commands refuse to run while the server is active. This is not a distributed lock or multi-replica architecture.

## Selection and failures

Filter by API family, key account scope, account model allowlist, enabled/reauth state, concurrency, model/project cooldown, and nonexpired exhausted Google quota buckets. Empty model allowlists permit all models; API-key quotas remain unknown. Reserve synchronously before asynchronous work. Choose least in-flight, with least-recently-selected tie breaking; release exactly once on success, failure, timeout, or disconnect.

Explicit account headers and established sessions override balancing, never silently migrate. Bind a new session before dispatch. Resource references (`cachedContent`, `fileData`, `thoughtSignature`) without explicit account or established session fail with 409. The gateway does not infer resource ownership or implement file/cache lifecycle operations.

At most three attempts, no repeated account per request. Retry only network failures before response, HTTP 408/429/500/502/503/504, or pre-output SSE Google errors. Never retry 401/403, or once bytes are visible to the client. Respect `Retry-After` and `google.rpc.RetryInfo`. Project-sharing API keys share model cooldowns. Daily exhaustion without a delay gets a conservative 24-hour cooldown, not a claimed exact reset; transient errors get short cooldowns. Pool exhaustion is Google-style 503/429 with `Retry-After` when known.

OAuth refresh is singleflight per account. Persist merged credentials atomically and preserve an omitted refresh token. `invalid_grant` marks the account `reauth_required` and excludes it until credential reimport. Access-token-only imports cannot refresh. No built-in browser login or automatic paid-credit opt-in.

## Wire handling and limits

Native JSON fields, multimodal parts, tool calls, and thought signatures are preserved. Code Assist envelopes are retained while project fields are rewritten for the selected account. Stored upstream credentials replace inbound credentials; query keys, cookies, arbitrary headers, and inbound authorization are never forwarded. The selected account is returned in `x-gemini-lb-account`.

SSE parsing handles CRLF, split Unicode, multiline data, and bounded events; malformed or empty streams fail. Apply downstream backpressure, cancel upstream on disconnect, and enforce the bounded deadline (default 120 seconds). Body limit is 16 MiB. Usage uses the last cumulative `usageMetadata`, never a sum of chunks. Request history is metadata-only, bounded to 1,000 rows, with success/failed/partial/cancelled outcomes; partial output is not recorded as success.

## Operations and boundaries

Dashboard and `/admin/*` use a separate Bearer admin token and same-origin policy, no CORS. The dashboard retains the token only in memory and renders untrusted values as text. `/healthz` is liveness, not upstream readiness. Quota refresh is available for OAuth only; no fabricated API-key quota percentages or graphs. Code Assist metrics are authenticated and discarded locally with 204.

Unsupported inference routes return structured 501. No Vertex, OpenAI adaptation, Live/WebSocket, Interactions, file/upload or cache lifecycle, batch jobs, proxy onboarding/operations, or multi-replica service. Code Assist is a private API and requires externally onboarded, authorized accounts. Real local upstream/SDK tests can validate gateway behavior but cannot establish Google account, billing, or service acceptance.
