## ADDED Requirements

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

## MODIFIED Requirements

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
