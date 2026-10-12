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
