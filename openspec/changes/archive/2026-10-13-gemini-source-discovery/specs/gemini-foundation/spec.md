## ADDED Requirements

### Requirement: Diagnose Google sources without generation
The dashboard SHALL offer a write-authorized action using stored credentials of an enabled Google source. API-key discovery SHALL read the paginated Google model catalog, preserving observed token limits and rejecting malformed or unbounded pagination. Code Assist SHALL validate the already onboarded project and report model IDs from observed quota rather than claiming a complete catalog. Diagnostics SHALL impose a thirty-second metadata deadline while retaining owned OAuth-refresh cleanup, SHALL NOT send generation requests, and SHALL NOT expose credentials or mark metadata success as inference health.

#### Scenario: Model catalog spans multiple pages
- **WHEN** Google returns a continuation token
- **THEN** discovery reads subsequent pages with encoded tokens, de-duplicates model IDs, and reports only native supported models

#### Scenario: Code Assist exposes only quota model IDs
- **WHEN** a project check and quota request succeed
- **THEN** the UI labels results as quota observations, persists the validated quota and states that inference has not been tested

### Requirement: Apply discovered models explicitly and preserve configuration
Google registration SHALL allow an empty model list and explain that it cannot route inference until models are configured. Operators SHALL be able to search and select discovered models. Applying selections SHALL add only absent IDs and preserve all previously configured models, prices, enabled state and capabilities. Empty selection SHALL NOT mean all models. Read-only users SHALL NOT initiate diagnostics or apply models. Failures SHALL retain stored model configuration and saved quota observations while displaying sanitized actionable errors.

#### Scenario: Discovery includes an already priced disabled model
- **WHEN** an operator applies that model and a new model
- **THEN** the existing model remains unchanged and only the new model is added
