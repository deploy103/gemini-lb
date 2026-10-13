# gemini-foundation Specification

## Purpose

Define the copied codex-lb foundation and native Gemini gateway contracts.

## Requirements

### Requirement: Preserve the upstream stack and build
The application SHALL retain Python/FastAPI/SQLAlchemy, React, uv, Bun, Make, Docker and the original upstream test suites. It SHALL NOT retain a parallel Node gateway as its primary runtime or delete tests to meet a line-count target.

#### Scenario: Build from a clean checkout
- **WHEN** an operator installs the documented toolchains and runs the upstream build commands
- **THEN** the backend wheel includes the built React frontend without a Node gateway service

### Requirement: Preserve retained operator capabilities
The application SHALL retain upstream account management, client-key policies, authorization, reports, routing and persistence. Provider-specific exclusions SHALL be documented, and Dither styling SHALL retain the forms, filters, actions and numerical data of retained workflows.

#### Scenario: Apply the operator redesign
- **WHEN** an operator opens a retained management workflow
- **THEN** its existing authorization and controls remain available

#### Scenario: Configure a native model allowlist
- **WHEN** an operator registers enabled Google models and opens the dashboard key-policy selector
- **THEN** the configured models are selectable even if the Codex registry is empty, without entering the OpenAI catalog

### Requirement: Authenticate and isolate native Google sources
Gemini API-key and Code Assist credentials SHALL be explicit encrypted model-source kinds. Every native Google request SHALL require a downstream gateway key independently of the Codex auth toggle. x-gemini-lb-key SHALL take precedence over a retained client Google bearer header. Routing SHALL enforce downstream model allowlists, source assignments, expiration, usage reservations and concurrency. Google credentials SHALL NOT enter Codex selection or OpenAI transports, and inbound credentials or arbitrary headers SHALL NOT be forwarded upstream.

#### Scenario: An OAuth client retains its Google bearer header
- **WHEN** it supplies a valid x-gemini-lb-key and its own Google Authorization header
- **THEN** the gateway authorizes the gateway key and sends only the selected stored credential upstream

#### Scenario: A key has an empty explicit source scope
- **WHEN** that key requests native Gemini inference
- **THEN** no upstream source is selected

### Requirement: Preserve the native protocol boundary
The gateway SHALL support model discovery, generateContent, streamGenerateContent, countTokens, embedContent and batchEmbedContents on /v1beta and equivalent /v1 model paths, with /gemini-prefixed equivalents. It SHALL preserve the retained OpenAI /v1/models catalog for Bearer-only clients. Streaming SHALL require alt=sse and preserve Google event payloads. Code Assist SHALL use allowlisted /v1internal RPCs and the configured operator project. Unsupported resource lifecycle and implicit onboarding SHALL be refused, and /healthz SHALL retain a JSON status and version response.

#### Scenario: Streaming lacks the SSE query parameter
- **WHEN** a client requests streamGenerateContent without alt=sse
- **THEN** the gateway returns a Google-shaped invalid-argument response without upstream dispatch

### Requirement: Persist ownership and bound failover
Ownership SHALL be atomically persisted per downstream key and provider for 24 hours. Explicit source pins SHALL respect assignment scope. Resource and signature references SHALL require a source pin or established session. Requests SHALL attempt at most three eligible sources before output, SHALL NOT fail over when pinned, and SHALL NOT replay after visible content. Cooldowns SHALL cover configured shared quota scope and model.

#### Scenario: An upstream stream fails after output
- **WHEN** the gateway has handed content to its client transport
- **THEN** it terminates with a Google error event, settles delivered usage and does not replay

### Requirement: Preserve OAuth identity under concurrent changes
Refresh SHALL use imported credentials and the matching configured OAuth client, serialize concurrent refreshes and persist rotations without overwriting operator changes. Refresh errors SHALL NOT reveal credentials. Invalid authentication SHALL mark the source as requiring reauthentication, and credential reimport SHALL clear that state. Paid-credit opt-in and implicit onboarding SHALL be refused.

#### Scenario: An operator replaces credentials during refresh
- **WHEN** the old refresh completes after credential replacement
- **THEN** it does not overwrite the operator's replacement

### Requirement: Expose observed Code Assist quota
Code Assist quota SHALL be retrieved only through authorized actions, persisted across restarts and used to exclude exhausted matching-model buckets until reset or a later snapshot. Invalid snapshots SHALL NOT replace prior observations. API-key quota SHALL be displayed as unknown rather than invented utilization.

#### Scenario: A quota bucket is exhausted
- **WHEN** a snapshot reports zero remaining matching-model quota and a future reset
- **THEN** that source is excluded until reset or a fresh positive observation

### Requirement: Protect legacy data
The runtime SHALL use a separate default data directory and SHALL NOT reinterpret a gemini-lb 0.1 database. Explicit offline import SHALL require stopped services and a new target, preserve credentials, key scopes and provider ownership, and leave source files unchanged. Noncheckpointed WAL, active locks and nonempty targets SHALL cause import refusal. Historical request import SHALL exclude prompt and response content.

#### Scenario: Start without explicit migration
- **WHEN** legacy data exists in the old default directory
- **THEN** starting this runtime does not modify that data

#### Scenario: Import an established legacy session
- **WHEN** the imported downstream key resumes that session
- **THEN** it remains bound to the original source and refuses dispatch if that source is deleted

### Requirement: Make primary account management Google native
The primary Accounts route SHALL manage Gemini API-key, enterprise Code Assist and personal Antigravity sources, including creation, editing, enable/disable, deletion, health and observed quota. Personal Antigravity SHALL be the default Google login choice. It SHALL NOT initiate ChatGPT authentication or display OpenAI protocol controls as Gemini capabilities. Retained Codex account and dashboard pages SHALL remain accessible only through explicitly labelled legacy routes. The primary dashboard SHALL display Google sources instead of Codex credit windows and SHALL retain request logs and gateway policy controls.

#### Scenario: Register a Gemini account
- **WHEN** an operator opens Accounts and chooses Add account
- **THEN** personal Antigravity login, enterprise Code Assist, Gemini API-key registration and provider-specific OAuth import are available without a ChatGPT login option

### Requirement: Connect Google accounts through bounded authorization transactions
Google login SHALL use authorization code with S256 PKCE, offline access and provider-specific redirect/scopes. Authorization transactions SHALL be encrypted, expire after ten minutes, be bound to the initiating dashboard session and require dashboard write authorization. Codes, tokens and client secrets SHALL NOT appear in response bodies or errors. Completion SHALL verify Google identity, resolve a project and save credentials using the existing encrypted source contract. Code Assist SHALL resolve only already onboarded projects. Antigravity SHALL permit only explicitly consented free-tier initialization attempts, with Google determining acceptance. Neither provider SHALL enable billing, paid-tier onboarding or paid-credit opt-in. API-key registration and explicit OAuth import SHALL remain available independently.

#### Scenario: A different session submits a connection transaction
- **WHEN** completion is attempted from a different dashboard session
- **THEN** the application refuses it before exchanging the authorization code

#### Scenario: Google account requires onboarding
- **WHEN** Google returns no usable project and consented free-tier initialization does not apply or cannot resolve a project
- **THEN** no source is registered and the operator receives actionable official-client setup instructions without an unsupported claim that no allocation was attempted

### Requirement: Diagnose Google sources without generation
The dashboard SHALL offer a write-authorized action using stored credentials of an enabled Google source. API-key discovery SHALL read the paginated Google model catalog, preserving observed token limits and rejecting malformed or unbounded pagination. Code Assist SHALL validate the already onboarded project and report model IDs from observed quota rather than claiming a complete catalog. Antigravity SHALL read its bounded account model mapping and observed quota without inferring Pro entitlement. Diagnostics SHALL impose a thirty-second metadata deadline while retaining owned OAuth-refresh cleanup, SHALL NOT send generation requests, and SHALL NOT expose credentials or mark metadata success as inference health.

#### Scenario: Model catalog spans multiple pages
- **WHEN** Google API-key discovery returns a continuation token
- **THEN** discovery reads subsequent pages with encoded tokens, de-duplicates model IDs, and reports only native supported models

#### Scenario: Code Assist exposes only quota model IDs
- **WHEN** a project check and quota request succeed
- **THEN** the UI labels results as quota observations, persists the validated quota and states that inference has not been tested

### Requirement: Apply discovered models explicitly and preserve configuration
Google registration SHALL allow an empty model list and explain that it cannot route inference until models are configured. Operators SHALL be able to search and select discovered models. Applying selections SHALL add only absent IDs and preserve all previously configured models, prices, enabled state and capabilities. Empty selection SHALL NOT mean all models. Read-only users SHALL NOT initiate diagnostics or apply models. Failures SHALL retain stored model configuration and saved quota observations while displaying sanitized actionable errors.

#### Scenario: Discovery includes an already priced disabled model
- **WHEN** an operator applies that model and a new model
- **THEN** the existing model remains unchanged and only the new model is added

### Requirement: Connect Antigravity personal accounts separately
The gateway SHALL support a distinct encrypted Antigravity OAuth source for free and subscribed personal Google accounts. It SHALL use a separately configured OAuth client, browser/session-bound encrypted ten-minute transactions, PKCE and validated loopback callback state. Existing Gemini CLI OAuth credentials SHALL NOT be reused as Antigravity identity. Actual model availability SHALL come from Google rather than an inferred subscription label. Initialization SHALL require explicit consent and request only the literal free-tier, with bounded requests and no paid-tier onboarding, billing activation or paid-credit opt-in. Missing tier advertisements SHALL NOT prevent this free-only attempt; Google SHALL remain authoritative about accepting it. Explicit validation, privacy and terms gates SHALL prevent the attempt.

#### Scenario: Personal account needs free initialization
- **WHEN** Google offers free initialization and the operator explicitly permits it
- **THEN** the gateway resolves the Google-managed project using bounded operations without sending a caller project or paid-credit opt-in

#### Scenario: Project and free-tier advertisement are absent
- **WHEN** project discovery returns neither a project nor an explicit validation gate and the operator permits free initialization
- **THEN** the gateway attempts only free-tier even if a catalog is absent or another tier is advertised, and refuses registration if Google rejects that attempt

#### Scenario: Google rejects free initialization
- **WHEN** the initialization endpoint returns HTTP 403
- **THEN** the connection error reports that initialization was attempted and retains the sanitized HTTP status without exposing Google's response body or credentials

#### Scenario: Callback is from another authorization attempt
- **WHEN** callback state does not match the encrypted transaction
- **THEN** the gateway refuses before exchanging the authorization code

### Requirement: Preserve native Gemini semantics through an Antigravity adapter
Explicit Antigravity native routes SHALL authenticate gateway keys and route only to assigned, enabled Antigravity sources and configured models. They SHALL wrap native requests with the stored project and unwrap Google responses, support ordinary and SSE generation and token counting, preserve observed usage, and retain existing limits, cancellation settlement and source affinity. Paid-credit request fields and unsupported methods SHALL be refused before upstream dispatch. Incomplete streams SHALL NOT be reported as successful generation. Account model/quota discovery SHALL be bounded, preserve saved configuration and distinguish observations from successful inference or monetary billing.

#### Scenario: A cumulative usage frame repeats
- **WHEN** an Antigravity stream reports the same cumulative usage more than once
- **THEN** one request is settled using the latest observation rather than summing frames

#### Scenario: Subscription label does not authorize a model
- **WHEN** Google refuses access to a discovered or configured model
- **THEN** the gateway reports the refusal without granting access based on free or Pro labels or opting into credits

#### Scenario: A native CLI appends a tool history
- **WHEN** a personal request without an explicit session appends messages while retaining its first user content
- **THEN** it retains ownership scoped by gateway key and provider; a conflicting pin or disabled owner is refused
