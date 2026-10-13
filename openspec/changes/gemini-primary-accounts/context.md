# Context

Google credentials already belong to ModelSource; creating a parallel account table would duplicate selection, encryption, refresh and quota ownership. Primary Accounts will reuse that source contract. Legacy Codex APIs remain for compatibility and their pages remain explicitly labelled.

Google's installed-client loopback callback cannot reach a remote VM from the user's browser. Use the official Gemini CLI remote authorization-code landing page and S256 PKCE, then accept the Google-issued code in the authenticated dashboard. Keep the transaction encrypted, short-lived and bound to the initiating dashboard session. Do not pretend this is OpenAI deviceauth or register a public callback on Google's client.

An existing Code Assist account can resolve its project using loadCodeAssist. If it needs onboarding or validation, stop with instructions to finish setup in the official CLI; do not silently call onboardUser or enable paid credits. Example: an operator signs into Google, pastes the returned authorization code, and registers the returned project as an encrypted gemini_code_assist source. Gemini API keys remain a separate registration path.
