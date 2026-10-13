"""Google authorization-code connection using Gemini CLI's remote-login flow."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import secrets
import time
from urllib.parse import parse_qs, urlencode, urlsplit

import aiohttp
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Request

from app.core.clients.http import lease_model_source_session
from app.core.config.settings import get_settings
from app.core.crypto import get_or_create_key
from app.core.exceptions import DashboardBadRequestError
from app.core.types import JsonValue
from app.modules.gemini import antigravity
from app.modules.gemini.credentials import GeminiSourceKind, GoogleCredential
from app.modules.gemini.transport import GoogleError, _read_json

# Public installed-application identity published by Google, not an operator secret.
# Source: google-gemini/gemini-cli, packages/core/src/code_assist/oauth2.ts
# Copyright 2025 Google LLC, Apache-2.0. No new redirects are registered on this client.
CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
CLIENT_SECRET = "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"
REDIRECT_URI = "https://codeassist.google.com/authcode"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo"
SETUP_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
ANTIGRAVITY_SETUP_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
ANTIGRAVITY_ONBOARD_ENDPOINT = antigravity.BASE_URL + "/v1internal:onboardUser"
AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
CONNECTION_COOKIE = "gemini_lb_google_connection"
TRANSACTION_TTL = 600
SCOPES = (
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
)


def _client_identity(kind: str) -> tuple[str, str, str]:
    if kind == "gemini_code_assist":
        return CLIENT_ID, CLIENT_SECRET, REDIRECT_URI
    if kind != "gemini_antigravity":
        raise DashboardBadRequestError("Select a supported Google OAuth provider.")
    settings = get_settings()
    client_id = (settings.gemini_antigravity_client_id or "").strip()
    configured_secret = settings.gemini_antigravity_client_secret
    client_secret = configured_secret.get_secret_value().strip() if configured_secret else ""
    if not client_id or not client_secret:
        raise DashboardBadRequestError(
            "Antigravity login requires the server OAuth client ID and client secret to be configured.",
            code="google_client_not_configured",
        )
    return client_id, client_secret, antigravity.REDIRECT_URI


def start_connection(binding: str, kind: GeminiSourceKind = "gemini_code_assist") -> tuple[str, str]:
    client_id, _, redirect_uri = _client_identity(kind)
    verifier = secrets.token_urlsafe(64)
    state = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    transaction = (
        Fernet(get_or_create_key())
        .encrypt(
            json.dumps(
                {
                    "binding": hashlib.sha256(binding.encode()).hexdigest(),
                    "verifier": verifier,
                    "state": state,
                    "kind": kind,
                    "client_id": client_id,
                }
            ).encode()
        )
        .decode()
    )
    scopes = (
        SCOPES + ("https://www.googleapis.com/auth/cclog", "https://www.googleapis.com/auth/experimentsandconfigs")
        if kind == "gemini_antigravity"
        else SCOPES
    )
    url = (
        AUTH_ENDPOINT
        + "?"
        + urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "access_type": "offline",
                "prompt": "consent select_account",
                "scope": " ".join(scopes),
                "code_challenge_method": "S256",
                "code_challenge": challenge,
                "state": state,
            }
        )
    )
    return url, transaction


def connection_binding(request: Request) -> str:
    # Bind even passwordless/trusted-header installations to one browser.
    # An authorization code is single-use at Google; PKCE ties it to this ticket.
    from app.modules.dashboard_auth.service import DASHBOARD_SESSION_COOKIE

    return request.cookies.get(CONNECTION_COOKIE, "") + ":" + request.cookies.get(DASHBOARD_SESSION_COOKIE, "")


async def _google_request(
    method: str,
    url: str,
    *,
    data: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    payload: dict[str, JsonValue] | None = None,
) -> dict[str, JsonValue]:
    try:
        async with lease_model_source_session() as http:
            async with http.request(
                method,
                url,
                data=data,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=20, connect=10),
                allow_redirects=False,
            ) as response:
                payload = await _read_json(response, cap=1024 * 1024)
                if response.status != 200 or "error" in payload:
                    raise DashboardBadRequestError(
                        f"Google rejected the connection (HTTP {response.status}). Start Google login again, "
                        "or complete setup in the official client and import credentials for the selected provider.",
                        code="google_connection_failed",
                    )
                return payload
    except (aiohttp.ClientError, TimeoutError, GoogleError):
        raise DashboardBadRequestError(
            "Google could not be reached. Start Google login again.", code="google_connection_failed"
        ) from None


async def complete_connection(
    transaction: str, code: str, binding: str, project: str | None, allow_free_setup: bool = False
) -> tuple[GeminiSourceKind, str, GoogleCredential]:
    try:
        ticket = json.loads(Fernet(get_or_create_key()).decrypt(transaction.encode(), ttl=TRANSACTION_TTL))
        if not isinstance(ticket, dict) or not secrets.compare_digest(
            ticket["binding"], hashlib.sha256(binding.encode()).hexdigest()
        ):
            raise InvalidToken
        kind = ticket.get("kind", "gemini_code_assist")
        if kind not in ("gemini_code_assist", "gemini_antigravity"):
            raise InvalidToken
        if not isinstance(ticket.get("verifier"), str) or not ticket["verifier"]:
            raise InvalidToken
    except (InvalidToken, ValueError, KeyError, TypeError):
        raise DashboardBadRequestError(
            "Google login expired or belongs to another session. Start Google login again.",
            code="invalid_google_transaction",
        ) from None
    client_id, client_secret, redirect_uri = _client_identity(kind)
    if ticket.get("client_id", CLIENT_ID) != client_id:
        raise DashboardBadRequestError(
            "Google OAuth client changed. Start Google login again.", code="invalid_google_transaction"
        )
    if kind == "gemini_antigravity":
        try:
            callback = urlsplit(code.strip())
            query = parse_qs(callback.query, keep_blank_values=True)
            if (
                callback.scheme != "http"
                or callback.netloc != "localhost:51121"
                or callback.path != "/oauth-callback"
                or callback.fragment
                or len(query.get("code", [])) != 1
                or not query["code"][0]
                or len(query.get("state", [])) != 1
                or "error" in query
                or not secrets.compare_digest(query["state"][0], ticket["state"])
            ):
                raise ValueError
            code = query["code"][0]
        except (ValueError, KeyError, TypeError):
            raise DashboardBadRequestError(
                "Paste the complete Antigravity loopback callback URL from this login attempt.",
                code="invalid_google_callback",
            ) from None
    tokens = await _google_request(
        "POST",
        TOKEN_ENDPOINT,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code.strip(),
            "code_verifier": ticket["verifier"],
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
    )
    token, refresh, expiry = tokens.get("access_token"), tokens.get("refresh_token"), tokens.get("expires_in")
    if (
        not isinstance(token, str)
        or not token
        or not isinstance(refresh, str)
        or not refresh
        or not isinstance(expiry, (int, float))
        or isinstance(expiry, bool)
        or not math.isfinite(expiry)
        or expiry <= 0
    ):
        raise DashboardBadRequestError("Google did not return renewable credentials. Start Google login again.")
    headers = {"Authorization": f"Bearer {token}"}
    if kind == "gemini_antigravity":
        headers["User-Agent"] = antigravity.USER_AGENT
    identity = await _google_request("GET", USERINFO_ENDPOINT, headers=headers)
    email, subject = identity.get("email"), identity.get("id")
    if not isinstance(email, str) or not email or not isinstance(subject, str) or not subject:
        raise DashboardBadRequestError("Google did not return an account identity. Start Google login again.")
    metadata: dict[str, JsonValue] = {
        "ideType": "IDE_UNSPECIFIED",
        "platform": "PLATFORM_UNSPECIFIED",
        "pluginType": "GEMINI",
    }
    setup_body: dict[str, JsonValue] = {"metadata": metadata}
    if kind == "gemini_antigravity":
        metadata = {"ideType": "ANTIGRAVITY"}
        setup_body = {"metadata": metadata}
    elif project:
        setup_body["cloudaicompanionProject"] = project
        metadata["duetProject"] = project
    setup_started = time.monotonic()
    setup = await _google_request(
        "POST",
        ANTIGRAVITY_SETUP_ENDPOINT if kind == "gemini_antigravity" else SETUP_ENDPOINT,
        headers=headers,
        payload=setup_body,
    )
    resolved_project = antigravity.account_project(setup)
    tier = setup.get("currentTier")
    if kind == "gemini_code_assist" and not resolved_project and isinstance(tier, dict) and tier.get("id"):
        resolved_project = project
    if _requires_validation(setup):
        raise DashboardBadRequestError(
            "Google requires account validation, privacy review or acceptance of new terms. "
            "Complete this in the official client before connecting.",
            code="google_setup_required",
        )
    if not resolved_project and kind == "gemini_antigravity" and allow_free_setup:
        # Discovery may omit free-tier even when Google accepts free onboarding.
        # Never substitute Google's default/current tier: it may not be free.
        resolved_project = await _initialize_free_account(headers, 60 - (time.monotonic() - setup_started))
    if not resolved_project:
        if kind == "gemini_antigravity":
            raise DashboardBadRequestError(
                "Google did not return an Antigravity project. Explicitly permit a free-tier initialization attempt, "
                "or complete any required setup in the official Antigravity client.",
                code="google_setup_required",
            )
        raise DashboardBadRequestError(
            "This account needs Code Assist setup or a Google Cloud project. Complete login in the official Gemini CLI "
            "first, then connect again or import its credentials. No project or billing settings were changed.",
            code="google_setup_required",
        )
    if kind == "gemini_code_assist" and project and resolved_project != project:
        raise DashboardBadRequestError("Google returned a different Code Assist project. Check the project ID.")
    try:
        credential = GoogleCredential(
            access_token=token,
            refresh_token=refresh,
            client_id=client_id,
            client_secret=client_secret,
            expiry_date=(time.time() + expiry) * 1000,
            project=resolved_project,
            quota_scope=f"google-user:{subject}",
        )
    except ValueError:
        # Pydantic validation errors can contain token and account input values.
        raise DashboardBadRequestError(
            "Google returned unusable account credentials. Check setup in the official client.",
            code="google_connection_failed",
        ) from None
    return kind, email, credential


def _requires_validation(payload: dict[str, JsonValue]) -> bool:
    # Refuse explicit control-plane gates rather than silently accepting new terms.
    privacy = payload.get("privacyNotice")
    if isinstance(privacy, dict) and privacy.get("showNotice") is True:
        return True
    if payload.get("hasAcceptedTos") is False:
        return True
    for key, value in payload.items():
        if key in {"validationRequired", "privacyNoticeRequired", "termsAcceptanceRequired", "requiresTermsAcceptance"}:
            if value:
                return True
        if (
            key == "reasonCode"
            and isinstance(value, str)
            and value in {"VALIDATION_REQUIRED", "PRIVACY_NOTICE_REQUIRED", "TERMS_ACCEPTANCE_REQUIRED"}
        ):
            return True
        if isinstance(value, dict) and _requires_validation(value):
            return True
        if isinstance(value, list) and any(isinstance(item, dict) and _requires_validation(item) for item in value):
            return True
    return False


async def _initialize_free_account(headers: dict[str, str], remaining_seconds: float) -> str:
    # Bounded repeated onboardUser requests follow CLIProxyAPI's control-plane
    # protocol, but only request free-tier with operator consent, never a default tier.
    # Reference attribution: app/modules/gemini/CLIProxyAPI-MIT.txt.
    body: dict[str, JsonValue] = {
        "tier_id": "free-tier",
        "metadata": {"ide_type": "ANTIGRAVITY", "ide_version": antigravity.VERSION, "ide_name": "antigravity"},
    }
    onboard_headers = {
        **headers,
        "User-Agent": antigravity.ONBOARD_USER_AGENT,
        "X-Goog-Api-Client": "gl-node/22.21.1",
    }
    failure = "Google's initialization operation remained pending after five polls."
    try:
        async with asyncio.timeout(max(0, remaining_seconds)):
            for attempt in range(5):
                result = await _google_request(
                    "POST",
                    ANTIGRAVITY_ONBOARD_ENDPOINT,
                    headers=onboard_headers,
                    payload=body,
                )
                if _requires_validation(result):
                    failure = "Google requires validation, privacy review or terms acceptance."
                    break
                if result.get("done") is True:
                    response = result.get("response")
                    project = antigravity.account_project(response) if isinstance(response, dict) else None
                    if project:
                        return project
                    failure = "Google completed initialization without returning a project."
                    break
                if attempt < 4:
                    await asyncio.sleep(2)
    except TimeoutError:
        failure = "The bounded Google initialization deadline expired."
    except DashboardBadRequestError as error:
        # _google_request has already removed upstream bodies and credentials.
        failure = error.message
    raise DashboardBadRequestError(
        "Google free initialization was attempted but a usable project was not confirmed. "
        f"{failure} "
        "Check the official Antigravity client before trying again.",
        code="google_setup_required",
    )
