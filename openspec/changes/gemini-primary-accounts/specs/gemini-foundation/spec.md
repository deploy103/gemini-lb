## ADDED Requirements

### Requirement: Make primary account management Google native
The primary Accounts route SHALL manage only Gemini API-key and Code Assist sources, including creation, editing, enable/disable, deletion, health and observed quota. It SHALL NOT initiate ChatGPT authentication or display OpenAI protocol controls as Gemini capabilities. Retained Codex account and dashboard pages SHALL remain accessible only through explicitly labelled legacy routes. The primary dashboard SHALL display Google sources instead of Codex credit windows and SHALL retain request logs and gateway policy controls.

#### Scenario: Register a Gemini account
- **WHEN** an operator opens Accounts and chooses Add account
- **THEN** Google login, Gemini API-key registration and OAuth credential import are available without a ChatGPT login option

### Requirement: Connect Google accounts through bounded authorization transactions
Google login SHALL use authorization code with S256 PKCE, offline access, the Gemini CLI remote-login redirect and Google consent scopes. Authorization transactions SHALL be encrypted, expire after ten minutes, be bound to the initiating dashboard session and require dashboard write authorization. Codes, tokens and client secrets SHALL NOT appear in response bodies or errors. Completion SHALL verify Google identity, resolve an already onboarded Code Assist project and save credentials using the existing encrypted source contract. It SHALL NOT initiate onboarding, project creation, billing or paid-credit opt-in. API-key registration and explicit OAuth import SHALL remain available independently.

#### Scenario: A different session submits a connection transaction
- **WHEN** completion is attempted from a different dashboard session
- **THEN** the application refuses it before exchanging the authorization code

#### Scenario: Google account requires onboarding
- **WHEN** loadCodeAssist has no current tier or usable project
- **THEN** no source is registered and the operator receives instructions to complete official Gemini CLI setup
