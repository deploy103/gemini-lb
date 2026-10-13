"""Google authorization-code connection using Gemini CLI's remote-login flow."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import secrets
import time
from urllib.parse import urlencode

import aiohttp
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Request

from app.core.clients.http import lease_model_source_session
from app.core.crypto import get_or_create_key
from app.core.exceptions import DashboardBadRequestError
from app.core.types import JsonValue
from app.modules.gemini.credentials import GoogleCredential
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
CONNECTION_COOKIE = "gemini_lb_google_connection"
TRANSACTION_TTL = 600
SCOPES = (
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
)


def start_connection(binding: str) -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    transaction = (
        Fernet(get_or_create_key())
        .encrypt(json.dumps({"binding": hashlib.sha256(binding.encode()).hexdigest(), "verifier": verifier}).encode())
        .decode()
    )
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(
        {
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "access_type": "offline",
            "prompt": "consent select_account",
            "scope": " ".join(SCOPES),
            "code_challenge_method": "S256",
            "code_challenge": challenge,
            "state": secrets.token_urlsafe(32),
        }
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
                        "Google rejected the connection. Start Google login again, or import existing CLI credentials.",
                        code="google_connection_failed",
                    )
                return payload
    except (aiohttp.ClientError, TimeoutError, GoogleError):
        raise DashboardBadRequestError(
            "Google could not be reached. Start Google login again.", code="google_connection_failed"
        ) from None


async def complete_connection(
    transaction: str, code: str, binding: str, project: str | None
) -> tuple[str, GoogleCredential]:
    try:
        ticket = json.loads(Fernet(get_or_create_key()).decrypt(transaction.encode(), ttl=TRANSACTION_TTL))
        if not secrets.compare_digest(ticket["binding"], hashlib.sha256(binding.encode()).hexdigest()):
            raise InvalidToken
    except (InvalidToken, ValueError, KeyError, TypeError):
        raise DashboardBadRequestError(
            "Google login expired or belongs to another session. Start Google login again.",
            code="invalid_google_transaction",
        ) from None
    tokens = await _google_request(
        "POST",
        TOKEN_ENDPOINT,
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "code": code.strip(),
            "code_verifier": ticket["verifier"],
            "redirect_uri": REDIRECT_URI,
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
    if project:
        setup_body["cloudaicompanionProject"] = project
        metadata["duetProject"] = project
    setup = await _google_request("POST", SETUP_ENDPOINT, headers=headers, payload=setup_body)
    resolved_project = setup.get("cloudaicompanionProject") or project
    tier = setup.get("currentTier")
    ineligible = setup.get("ineligibleTiers")
    needs_validation = isinstance(ineligible, list) and any(
        isinstance(item, dict) and item.get("reasonCode") == "VALIDATION_REQUIRED" for item in ineligible
    )
    if (
        not isinstance(tier, dict)
        or not isinstance(tier.get("id"), str)
        or not tier["id"]
        or not isinstance(resolved_project, str)
        or not resolved_project
        or needs_validation
    ):
        raise DashboardBadRequestError(
            "This account needs Code Assist setup or a Google Cloud project. Complete login in the official Gemini CLI "
            "first, then connect again or import its credentials. No project or billing settings were changed.",
            code="google_setup_required",
        )
    if project and resolved_project != project:
        raise DashboardBadRequestError("Google returned a different Code Assist project. Check the project ID.")
    return email, GoogleCredential(
        access_token=token,
        refresh_token=refresh,
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        expiry_date=(time.time() + expiry) * 1000,
        project=resolved_project,
        quota_scope=f"google-user:{subject}",
    )
