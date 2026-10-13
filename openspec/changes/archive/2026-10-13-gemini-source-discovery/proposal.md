# Google source diagnostics and guided model registration

## Why
The copied upstream stack is already retained, but native Google onboarding still requires model IDs and has no explicit metadata connection check. Reuse its source editing, credential transport and query invalidation rather than adding a second account runtime.

## What Changes
- Permit Google registration without models, leaving the source unroutable until models are explicitly configured.
- Add a write-authorized, bounded saved-credential diagnostic action. API keys read the paginated Google catalog; Code Assist validates its existing project and reports model IDs observed in quota.
- Present searchable, explicit model selection and merge selected additions with existing models without changing pricing, capabilities or enabled state.
- Show sanitized failures and retain prior quota observations.

## Non-goals
No inference probe, billing/onboarding, background polling, automatic model enablement, credentials in responses, schema migration or infrastructure changes. A metadata check is not proof of successful inference.
