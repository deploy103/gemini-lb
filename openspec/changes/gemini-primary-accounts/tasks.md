## Implementation
- [x] Add authenticated, session-bound Google authorization-code/PKCE connection endpoints.
- [x] Replace the primary Accounts route with Gemini sources, Google login, API-key registration and OAuth import.
- [x] Replace Codex credit/account surfaces on the primary dashboard and remove default header credit polling.
- [x] Preserve legacy account/dashboard routes and provider controls.

## Verification
- [x] Exercise Google connection success, rejected/expired/session-mismatched transactions, and unavailable projects through HTTP.
- [x] Verify native account registration, controls and quota through frontend public interactions.
- [x] Run native gateway regression tests, frontend checks, build and OpenSpec validation.
- [x] Render and inspect desktop/mobile account, login and dashboard states.
- [ ] Deploy the verified application update and inspect HTTPS without changing infrastructure.
