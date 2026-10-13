# Gemini setup and compatibility

Normative contracts: [gemini-foundation OpenSpec](../openspec/specs/gemini-foundation/spec.md). Source provenance, choices and exclusions: [capability context](../openspec/specs/gemini-foundation/context.md).

## Build and run this repository

Install Python 3.13 or later, uv and Bun 1.3.14. The copied build stays unchanged:

```sh
uv sync --dev --frozen
make frontend-build
uv run gemini-lb
```

The dashboard listens on port 2455. Remote first-run access uses the retained bootstrap/password/TOTP and role controls; see the upstream authentication guide. Set `CODEX_LB_DATA_DIR` to an explicit new directory when needed. Configuration retains `CODEX_LB_*` names for compatibility. Defaults are `~/.gemini-lb-v2/` locally and `/var/lib/codex-lb/gemini-lb-v2/` inside Docker. Never reuse the old 0.1 database URL.

`make package` builds and verifies the wheel with bundled frontend assets. The distribution and internal version remain `codex-lb`/`1.25.0-beta.9` to preserve the copied build; `gemini-lb` is a CLI alias. There is no published Gemini PyPI package or container image. `docker build -t gemini-lb:local .` builds the retained Dockerfile locally; upstream images, nix references, Helm defaults and old deployment guides are not Gemini artifacts.

## Add Google sources

In **Accounts → Add account**, choose Google login, Gemini API key or OAuth JSON import. Personal/free/AI Pro accounts use **Antigravity** by default; enterprise Code Assist remains a separate option. Personal login opens Google's consent screen and requires the complete `http://localhost:51121/oauth-callback?code=...&state=...` address afterward, even if localhost cannot load. No local listener is required. **Settings → Advanced settings → Model sources** retains advanced provider configuration. The **APIs** page manages downstream client keys, not Google credentials.

- **Gemini API key**: base URL `https://generativelanguage.googleapis.com`, credential containing the Google API key. To group project-level quota, use `{"api_key":"YOUR_GOOGLE_KEY","quota_scope":"my-google-project"}`.
- **Antigravity OAuth**: base URL `https://daily-cloudcode-pa.googleapis.com`. Set the authorized installed-application OAuth profile in server-only `GEMINI_LB_ANTIGRAVITY_CLIENT_ID` and `GEMINI_LB_ANTIGRAVITY_CLIENT_SECRET` for browser login. Import requires this provider's own `project`, `access_token`, millisecond `expiry_date` and matching refresh credentials, not Gemini CLI's OAuth identity.
- **Gemini Code Assist OAuth**: base URL `https://cloudcode-pa.googleapis.com`, OAuth JSON containing an already onboarded `project`, `access_token`, and `expiry_date` in Unix milliseconds. Refresh requires the matching `refresh_token`, `client_id` and `client_secret`. An access-only import works until expiration, then requires reimport.

Use credentials from your own authorized account and OAuth registration. Existing personal projects are resolved from Google. The unchecked **free initialization** option permits bounded Google-managed project allocation only when Google offers the free tier. It never activates billing, selects a paid onboarding tier or opts into paid credits. Validation, privacy and terms gates require completion in the official client. Enterprise setup remains external. Never put Google credentials into downstream key headers or commit them.

Google [ended consumer Gemini CLI/Code Assist access on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli). Free and AI Pro access moved to Antigravity. API-key billing is separate from subscription quota. This gateway's Antigravity adapter uses a private protocol based on the MIT-licensed CLIProxyAPI reference, not a Google-supported OAuth gateway contract; compatibility does not establish entitlement or continued provider support.

Each source can define enabled models, streaming support, concurrency and prices. Configure actual input/output/cache prices before relying on dollar limits; unset prices are not an accurate billing estimate. Google usage includes reported thinking output tokens. Source OpenAI capability toggles govern retained OpenAI transports, not native Google methods.

Model IDs are optional during primary account registration. An empty model list cannot route requests or shadow configured sources in the native catalog. After connecting, open **Connection & models → Check connection and discover models**, search the results and explicitly add selected models. API keys read Google's paginated model catalog and token limits. Code Assist checks the existing project and reports IDs observed in quota, not a complete model catalog.

This check sends no generation request and does not prove inference access. It has a thirty-second metadata deadline, at most ten catalog pages and 1,000 rows. Existing models, disabled states, prices and capabilities remain unchanged; only selected absent IDs are added. Tools and vision are not inferred from a model's name. Configure verified capabilities or manual IDs in Edit when needed. Read-only users cannot initiate checks or apply models.

OAuth edit dialogs show the last persisted quota observation, an explicit **Refresh quota** action, unknown/empty states and refresh failures. Antigravity discovers an account-provided model mapping with observed quota fractions/reset times. These are not exact request counts or proof of Pro status. API-key quota remains unknown. Refresh uses saved credentials rather than unsaved form edits. A zero remaining bucket prevents matching-model dispatch until reset or a later positive observation.

## Connect clients

Create a separate gateway API key in the dashboard. You may limit its models, source assignments, requests, tokens and dollar usage. Native Google rejects Codex credit limits and incompatible OpenAI reasoning/service-tier restrictions explicitly.

For the Google Python SDK (install `google-genai` in your client environment):

```python
import os
from google import genai
from google.genai import types

client = genai.Client(
    api_key=os.environ["GEMINI_LB_KEY"],
    http_options=types.HttpOptions(base_url="http://127.0.0.1:2455"),
)
result = client.models.generate_content(model="gemini-2.5-flash", contents="Hello")
print(result.text)
```

REST supports `/v1beta/models`, `/v1/models`, and `/gemini/v1beta` or `/gemini/v1` aliases. Google SDK headers select the native `/v1/models` catalog; Bearer-only `/v1/models` retains the OpenAI catalog. Use the `/gemini` alias for an unambiguous Bearer-only native catalog. Generate, SSE stream, count-token and embedding methods retain native JSON. Streams require `?alt=sse`.

Code Assist clients use allowlisted `/v1internal:*` RPCs. Configure `x-gemini-lb-key` with the downstream gateway key; it takes precedence over the CLI's Google Authorization header. Only the selected stored token and project reach Google. Dashboard Google connection is separate from client authentication; this is not an OpenAI-compatible Gemini conversion service.

For personal accounts, use the explicit base URL `https://gemini.mvtp.cloud/antigravity`. It exposes `/v1beta/models` and `/v1/models`, ordinary/SSE generation and countTokens. Embeddings, resource lifecycle and catalog pagination are explicitly unsupported on this provider; the API-key provider retains its native methods. Request controls are not silently discarded to imitate another client: Google may reject unsupported generation settings.

Gemini CLI supports a native gateway:

```sh
export GEMINI_API_KEY="YOUR_GATEWAY_KEY"
export GOOGLE_GEMINI_BASE_URL="https://gemini.mvtp.cloud/antigravity"
export GEMINI_CLI_CUSTOM_HEADERS="x-gemini-lb-session: $(uuidgen)"
gemini
```

Use gateway/API-key authentication, not the discontinued personal Code Assist login. For Antigravity CLI (`agy`), set `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and export the same API-key/base-URL variables. Its [official guide](https://antigravity.google/docs/cli/install/#using-a-gemini-api-key) requires this setting and does not load the key from `.env` files. These client settings select this gateway; they do not convert a subscription into a paid Gemini API key.

Optional headers:

| Header | Meaning |
| --- | --- |
| `x-gemini-lb-session` | Stable session ownership, scoped by gateway key and provider, lasting 24 hours |
| `x-gemini-lb-account` | Explicit model-source ID; must be within the key's assignments |

The response reports its source ID in `x-gemini-lb-account`. File/cache references and thought signatures require a source pin or established session. Personal native requests without a session header derive ownership from the first user content, scoped by gateway key/provider, so appended tool histories retain their account. Identical initial content shares ownership; explicit unique session headers distinguish conversations. After history compaction, preserve the session header or source pin before replaying signatures. Deleted/disabled owners refuse dispatch rather than moving their resources. Retry is bounded to three sources before output, never after content or for pinned requests. Resource creation/upload/cache lifecycle APIs are not implemented.

## Import gemini-lb 0.1 data offline

Stop both services, back up the complete legacy directory, and checkpoint its SQLite WAL using the old service's normal shutdown. Do not delete WAL to force import. Use a new target directory:

```sh
uv run python -m scripts.import_legacy_gemini /path/to/legacy /path/to/new-target --stopped --dry-run
uv run python -m scripts.import_legacy_gemini /path/to/legacy /path/to/new-target --stopped
CODEX_LB_DATA_DIR=/path/to/new-target uv run gemini-lb
```

The importer refuses active lock files, noncheckpointed WAL, unsupported schema and nonempty targets. It reads the source immutably, stages a new database, re-encrypts credentials and publishes only after migration succeeds. Source files remain unchanged. It retains IDs, enabled/reauth state, downstream key hashes and source assignments, sessions, cooldowns, quota observations and metadata-only request history. Old admin endpoints are not compatibility aliases; administration uses the retained codex-lb APIs.

## Validation and limits

Run `make lint typecheck package`, `make frontend-test`, `make test-dashboard-browser-smoke` and the original backend suites. Native regressions live in `tests/integration/test_gemini_gateway.py` and `test_gemini_legacy_import.py`. They exercise real HTTP fixtures, concurrent OAuth refresh/reimport, quota, billing, streaming/disconnect and durable ownership without sending your credentials to Google.

The untouched upstream has two observed Python 3.14 shutdown-test failures; no test is excluded to hide them. Local Docker execution was unavailable, and live Google account validation needs separately supplied authorized credentials. Public-repository publication is not a production deployment or data migration.
