# gemini-lb 0.1 contract

This is a single-process, self-hosted gateway, inspired by codex-lb, not a fork or a parity claim. Node 24, TypeScript, Fastify, SQLite WAL. No upstream secrets or prompt/response bodies in logs. No external telemetry. No automatic paid-credit opt-in.

## Identity and storage

Three separate identities: upstream accounts; downstream client keys; operator admin token. Credentials encrypted with AES-256-GCM, random nonce and account-ID additional authenticated data. Master key and hashed operator token in mode-0600 secrets.json in a mode-0700 data directory. Client keys hashed in SQLite; issued once with a label and optional allowed-account scope. Back up secrets.json and SQLite together. A filesystem lock rejects a second server on the same data directory; no multi-replica support. Never write the original Gemini CLI credential cache.

Account fields: id, name, kind (api-key or oauth), project, quotaScope, models (empty = all), maxInflight (default 4), enabled, state (ready or reauth_required), cooldownUntil, quota (Google buckets or null), quotaUpdatedAt, inflight. API-key accounts require a project/quota scope; same project's keys share model cooldowns. OAuth import accepts access_token, refresh_token, expiry_date and matching client_id/client_secret. Gemini CLI's cache lacks the OAuth client registration; operator supplies it separately. Refresh singleflight keyed by account; persist merged credentials atomically, preserve omitted refresh token; invalid_grant disables account for routing until reimport. No built-in OAuth browser flow in 0.1.

## Routing and retries

Choose least in-flight eligible account; ties prefer least recently selected. Filter provider family, enabled/reauth state, model allowlist, max concurrency, model/project cooldown and nonexpired exhausted quota buckets. No invented API-key quota percentages. Reserve slot synchronously before asynchronous I/O. Release exactly once on every path. Three attempts maximum, no repeated account per request. Retries only for network failures before response, HTTP 408/429/500/502/503/504, and pre-output SSE Google error events. Respect Retry-After and google.rpc.RetryInfo. Authentication 401/403 never retries or silently changes accounts. Daily quota with no delay conservatively cools scope for 24 hours; not an invented exact reset. Transient errors use short cooldown. Pool exhaustion returns structured Google-style 503/429 with Retry-After when known.

Never replay after response bytes become client-visible. Stream JSON events are parsed before emitting; unknown fields, native parts, tool calls and thought signatures preserved. SSE events have bounded size; support CRLF, split Unicode and multiline data. An empty/malformed upstream stream fails, not silent success. Respect downstream backpressure, cancel upstream on disconnect, bounded request deadline. Usage is last cumulative usageMetadata, not sum of stream chunks. Failed/partial requests recorded as such. Metadata-only bounded request history.

Hard affinity: explicit x-gemini-lb-account; session via x-gemini-lb-session or Code Assist request.session_id, hashed with client-key ID and persisted for 24 hours. Bind before dispatch and never silently move a pinned session. Resource references (cachedContent, fileData, thoughtSignature) require explicit account or a previously established session; otherwise 409. No file/cache lifecycle proxy. Resource ownership is operator-managed, never guessed.

## Public routes

All inference routes require client key as x-goog-api-key, Authorization: Bearer, or x-gemini-lb-key. Custom header wins over Google's bearer token for Code Assist clients. Ignore inbound Google credentials; always use stored selected account. Never forward query key, authorization, cookies or arbitrary headers upstream. x-gemini-lb-account response identifies selected account.

- GET /healthz: liveness only, no account info.
- POST /v1beta/models/:model:generateContent and :streamGenerateContent?alt=sse; :countTokens; :embedContent and :batchEmbedContents, with equivalent /v1 paths. api-key accounts only. Native request/response transparent.
- GET /v1beta/models and /v1beta/models/:model (also /v1): upstream model discovery, respecting account's allowlist.
- POST /v1internal:generateContent, :streamGenerateContent?alt=sse, :countTokens: oauth accounts only, preserve Code Assist envelope; overwrite project with selected account project. Credit opt-in requests rejected in 0.1.
- POST /v1internal:loadCodeAssist, :retrieveUserQuota, :fetchAdminControls, :listExperiments: forward on one selected OAuth account; rewrite project fields. loadCodeAssist requires an already-onboarded account, otherwise explicit operator error. No proxy onboarding, operations or account mutation; onboard using official Gemini CLI first.
- POST /v1internal:recordCodeAssistMetrics: validated client authentication, return 204 locally; no telemetry forwarding.
- Unsupported inference routes return structured 501. Live/WebSocket, Interactions, Files/upload, caches, batch jobs, Vertex and OpenAI conversion unsupported, not silently approximated.

## Operator API and dashboard

Admin API /admin/* requires separate Bearer admin token; reject cross-origin browser requests; same-origin only, no CORS. Dashboard token stays in memory, not browser persistent storage. Same TLS listener, default host 127.0.0.1 port 2456. For remote access use TLS reverse proxy; no unauthenticated remote mode.

- GET /admin/overview: {accounts, requests, stats}. stats: {requests, errors, tokens, inflight}. accounts as public fields above without credential, plus effective state/cooldown. requests newest first: {id, accountId, model, method, status, outcome, attempts, tokens, durationMs, createdAt}, no body or error text. outcome: success, failed, partial, cancelled.
- POST /admin/accounts: {name, kind, project, credential, models?, maxInflight?}. credential for api-key: {api_key}; oauth: {access_token?, refresh_token?, expiry_date?, client_id?, client_secret?}. project required. Returns public account. No credentials returned.
- PATCH /admin/accounts/:id: {enabled?, models?, maxInflight?}. No delete in UI; disable preserves session ownership/history.
- POST /admin/accounts/:id/quota: OAuth only; retrieves Google quota snapshot, returns public account. API-key quotas unknown.
- POST /admin/accounts/:id/credentials: {credential}; encrypted reimport resets reauth state, keeps account/project ownership.
- POST /admin/keys: {name, accounts?: string[]}. Returns {id,key} once.
- GET /admin/keys: [{id,name,accounts,enabled,createdAt}]. PATCH /admin/keys/:id {enabled} revokes/restores.

Dashboard: dark restrained ops console, overview counts, account pool table, request history, connect-token form, add API-key/OAuth drawer, enable/disable and refresh OAuth quota, client-key issue/revoke. No fabricated stats, graphs or quota bars. Empty/error/auth states and mobile widths supported. Inline textContent/rendered text only for untrusted data, never HTML interpolation.

## Acceptance evidence

Real local HTTP upstreams plus native Google SDK: wire preservation (tool calls, multimodal, thought signatures), split SSE, exact cumulative usage, bounded failover, shared-project cooldown, hard affinity across restart/client-key isolation, unauthorized requests and wrong token class, allowlists, invalid credential handling, concurrent refresh with omitted refresh token, disconnect/cancellation and slot cleanup, no replay after partial output, request timeout, persistence encryption. Live Google account/billing validation requires operator-provided credentials and is not implied by simulated upstream tests. Render and inspect dashboard default, add-account and mobile states. Publish only after type checks, tests, dependency audit and secret review.
