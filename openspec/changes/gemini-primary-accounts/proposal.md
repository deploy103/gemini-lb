# Gemini-first account management

## Why
The primary Accounts route still invokes Codex OAuth. Google credentials are hidden in Settings, and the dashboard displays Codex credit windows rather than Gemini sources.

## What Changes
- Make Accounts manage encrypted Google API-key and Code Assist sources.
- Add Google authorization-code login with PKCE through the Gemini CLI remote-login redirect; retain explicit credential import.
- Resolve an existing Code Assist project without activating billing, credits, or implicit onboarding.
- Show Google source health and observed quota on the primary dashboard; keep legacy controls on explicitly labelled legacy routes.
- Preserve the upstream stack, gateway policy enforcement, retained APIs, and data.

## Impact
Dashboard navigation, Google account connection, and account forms. No database migration or infrastructure change.
