# Context

Upstream subscription-account discovery fetches a provider catalog separately from OAuth and keeps identity-specific availability. Generic upstream model sources still use manual IDs, so copying that dialog does not complete native Google onboarding. This change follows the existing encrypted source control plane and explicit model updates.

Example: register an API key without guessing model names, run the saved-source metadata check, search its catalog and add selected models. Existing operator prices and disabled models survive. Code Assist quota IDs are observations, not a complete catalog or proof of inference access. Manual model editing remains available when discovery is unavailable.

Risks: pagination loops, accidentally treating an empty selection as all, overwriting model overrides, credential reflection and falsely reporting generation health. Bound discovery, normalize only known metadata, preserve existing rows in the update payload, and label the check narrowly.

Verification: 244 related backend cases passed, followed by 41 final native/legacy cases after excluding model-less sources from client routing and catalogs. All 1,655 frontend cases and ten real-backend browser cases passed. Browser fixtures use actual local HTTP Google servers, not dashboard response mocks, for the new discovery flow. Inspected default, error, desktop/mobile selection, scrolled 320px, Code Assist quota and stale-quota failure states. Lint, architecture checks, types and copied frontend build passed. The original wildcard behavior failed the new empty-model regression before correction.

Live Google consent and generation access remain unverified. Publication remains blocked pending explicit approval for the two official-public OAuth constants; no GitHub protection exception has been applied. No schema migration or proxy/router/DNS change is included.
