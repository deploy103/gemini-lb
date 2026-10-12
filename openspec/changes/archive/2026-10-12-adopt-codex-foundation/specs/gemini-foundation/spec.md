## ADDED Requirements

### Requirement: Preserve the upstream stack and build
The application SHALL use the pinned codex-lb Python/FastAPI/SQLAlchemy runtime and React frontend with uv, Bun and the upstream Make-based build and test workflow. The application SHALL NOT retain a parallel Node gateway as its primary runtime.

#### Scenario: Build from a clean checkout
- **WHEN** an operator installs the supported Python and Bun toolchains and runs the documented upstream build commands
- **THEN** the backend package and React frontend build without a separate Node gateway service

### Requirement: Preserve retained operator capabilities
The application SHALL retain upstream account management, client key policy, access controls, reports, routing and persistence unless a provider-specific exclusion is explicitly documented. Removing tests solely to meet a line-count target SHALL NOT be permitted.

#### Scenario: Apply a visual redesign
- **WHEN** an operator uses a retained management workflow after the Dither Kit redesign
- **THEN** its authorization, forms, actions, filters and numerical data remain available

### Requirement: Preserve native Gemini ownership and streaming
Gemini protocol implementations SHALL authenticate downstream requests independently of upstream credentials and SHALL NOT replay requests after client-visible output or move provider-owned resources to another account.

#### Scenario: Upstream stream fails after output
- **WHEN** a Gemini stream has emitted content and the upstream fails
- **THEN** the request terminates without replay on another account

### Requirement: Protect legacy data during adoption
The application SHALL NOT reinterpret an existing gemini-lb 0.1 database as a codex-lb database. Any migration SHALL preserve credentials, scope and provider ownership and SHALL leave the source store unchanged.

#### Scenario: Existing legacy data is present
- **WHEN** the new runtime is started without an explicit legacy import
- **THEN** it does not modify the legacy store

### Requirement: Reuse the retained model-source control plane
Gemini API-key and Code Assist OAuth credentials SHALL be explicit model-source kinds, encrypted by the retained credential store and managed through its authorized dashboard APIs. Gemini routing SHALL enforce client model allowlists, source assignments, expiration, usage reservations and concurrency admission. Enabled configured Google models SHALL appear in dashboard key-policy selectors even without a Codex registry, but SHALL NOT enter the OpenAI catalog. Google credentials SHALL NOT enter Codex account selection or OpenAI-compatible transports.

#### Scenario: Client key has an empty explicit source scope
- **WHEN** a valid client key with source scoping enabled and no assigned sources requests Gemini inference
- **THEN** no Google account is selected and no upstream request is made

#### Scenario: Configure a native model allowlist
- **WHEN** an operator registers enabled Google models and opens the dashboard key-policy selector
- **THEN** those models are selectable even if the Codex model registry is empty

### Requirement: Preserve native Google protocol contracts
The gateway SHALL support Gemini model discovery, generateContent, streamGenerateContent, countTokens, embedContent and batchEmbedContents on /v1beta and equivalent /v1 model paths. Streams SHALL require alt=sse and preserve Google SSE payloads. Code Assist SHALL use /v1internal RPCs and a configured Google project, not a client-provided project. Every Google request SHALL require a downstream key independently of the global Codex proxy-auth toggle. Query keys and arbitrary client headers SHALL NOT be forwarded upstream.

#### Scenario: Client authenticates using a Google SDK header
- **WHEN** a client sends its gateway key in x-goog-api-key
- **THEN** the gateway validates that key and sends only the selected source credential to Google

### Requirement: Persist Gemini ownership and bound failover
Session ownership SHALL be persisted per downstream key and provider for 24 hours, claimed atomically before dispatch, and SHALL NOT be overwritten by concurrent requests. Explicit source selection SHALL respect assignment scopes. Provider-owned resource references SHALL require explicit source selection or established session ownership. Requests SHALL attempt at most three eligible sources before output, and SHALL NOT fail over when pinned. Provider quota cooldown SHALL cover sources sharing a configured quota scope and model.

#### Scenario: Two requests race to establish the same session
- **WHEN** two requests from one client key establish the same Gemini session
- **THEN** both use one persisted source or one request refuses dispatch without moving ownership

### Requirement: Preserve Gemini OAuth identity
Code Assist sources SHALL use imported OAuth credentials and the matching configured OAuth client for refresh. Refresh SHALL persist rotated credentials without overwriting concurrent operator changes. Refresh errors SHALL NOT expose tokens, and the gateway SHALL NOT enable paid credits or onboard projects implicitly.

#### Scenario: Operator replaces credentials during a refresh
- **WHEN** refresh completes after an operator has replaced the encrypted credential
- **THEN** the refresh result does not overwrite the replacement

### Requirement: Preserve explicit Gemini credentials and observed quota
Code Assist clients SHALL be able to authenticate with x-gemini-lb-key while retaining their Google Authorization header; the custom gateway key SHALL take precedence and the inbound Google token SHALL NOT be forwarded. Observed Code Assist quota snapshots SHALL be available through an authorized operator action, persisted across restart and used to exclude exhausted matching-model buckets until their reported reset or a fresh snapshot. API-key quota SHALL remain unknown rather than displaying invented utilization. Reimporting credentials SHALL clear a Google reauthentication-required state.

#### Scenario: OAuth client retains its Google bearer header
- **WHEN** a client supplies a valid x-gemini-lb-key and its own Google bearer token
- **THEN** the gateway authorizes the gateway key and forwards only the selected stored Google credential

#### Scenario: A retrieved quota bucket is exhausted
- **WHEN** a Google snapshot reports zero remaining quota for the requested model and a future reset
- **THEN** that source is excluded until reset or a later snapshot restores capacity
