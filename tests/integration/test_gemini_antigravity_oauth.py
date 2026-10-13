"""Personal Google login through the public dashboard and fixture-only HTTP."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from aiohttp import web
from cryptography.fernet import Fernet

from app.core.config.settings import get_settings
from app.core.crypto import TokenEncryptor, get_or_create_key
from app.db.models import ModelSource
from app.db.session import SessionLocal
from app.modules.gemini import antigravity, oauth
from tests.integration.model_source_helpers import stub_source_upstreams

pytestmark = pytest.mark.integration


@pytest.fixture
def antigravity_client(monkeypatch):
    monkeypatch.setenv("GEMINI_LB_ANTIGRAVITY_CLIENT_ID", "fixture-client")
    monkeypatch.setenv("GEMINI_LB_ANTIGRAVITY_CLIENT_SECRET", "fixture-private-secret")
    get_settings.cache_clear()


@pytest.fixture
async def auth_upstream(monkeypatch, antigravity_client):
    async with stub_source_upstreams() as start:

        async def configure(handler):
            base = (await start(handler)).removesuffix("/v1")
            for endpoint, path in (
                ("TOKEN_ENDPOINT", "token"),
                ("USERINFO_ENDPOINT", "userinfo"),
                ("ANTIGRAVITY_SETUP_ENDPOINT", "setup"),
                ("ANTIGRAVITY_ONBOARD_ENDPOINT", "onboard"),
            ):
                monkeypatch.setattr(oauth, endpoint, f"{base}/{path}")

        yield configure


async def _start(client):
    response = await client.post("/api/model-sources/google/start", json={"kind": "gemini_antigravity"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "HttpOnly" in response.headers["set-cookie"]
    query = parse_qs(urlsplit(response.json()["authorizationUrl"]).query)
    assert query["client_id"] == ["fixture-client"]
    assert query["redirect_uri"] == [antigravity.REDIRECT_URI]
    assert query["code_challenge_method"] == ["S256"] and query["access_type"] == ["offline"]
    assert "consent" in query["prompt"][0]
    assert set(query["scope"][0].split()) == set(oauth.SCOPES) | {
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    }
    assert "fixture-private-secret" not in response.text
    return response.json()["transaction"], query


def _callback(query):
    return antigravity.REDIRECT_URI + "?" + urlencode({"code": "private-code", "state": query["state"][0]})


@pytest.mark.parametrize(
    "case,consent,success,onboard_count",
    [
        ("pro-string", False, True, 0),
        ("pro-object", False, True, 0),
        ("project-id", False, True, 0),
        ("project-object", False, True, 0),
        ("free-existing", False, True, 0),
        ("free", True, True, 1),
        ("free", False, False, 0),
        ("non-free-advertised", True, False, 1),
        ("none-offered", True, True, 1),
        ("none-offered", False, False, 0),
        ("catalog-absent", True, True, 1),
        ("validation", True, False, 0),
        ("privacy", True, False, 0),
        ("terms", True, False, 0),
        ("privacy-object", True, False, 0),
        ("terms-unaccepted", True, False, 0),
        ("pending", True, False, 5),
        ("failed", True, False, 1),
        ("onboard-validation", True, False, 1),
    ],
)
async def test_antigravity_account_metadata_and_explicit_free_setup(
    async_client, auth_upstream, case, consent, success, onboard_count
):
    observed = []
    authorization = {}

    async def handler(request):
        observed.append(request.path)
        if request.path == "/token":
            form = await request.post()
            assert form["client_id"] == "fixture-client" and form["client_secret"] == "fixture-private-secret"
            assert form["redirect_uri"] == antigravity.REDIRECT_URI and form["code"] == "private-code"
            challenge = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest())
            assert challenge.decode().rstrip("=") == authorization["code_challenge"][0]
            return web.json_response(
                {"access_token": "private-access", "refresh_token": "private-refresh", "expires_in": 3600}
            )
        assert request.headers["Authorization"] == "Bearer private-access"
        if request.path == "/userinfo":
            return web.json_response({"id": "123", "email": "personal@example.com"})
        if request.path == "/setup":
            assert request.headers["User-Agent"] == antigravity.USER_AGENT
            assert await request.json() == {"metadata": {"ideType": "ANTIGRAVITY"}}
            if case in {"pro-string", "pro-object", "free-existing"}:
                return web.json_response(
                    {
                        "currentTier": {"name": "Google AI Pro" if case != "free-existing" else "Free"},
                        "cloudaicompanionProject": {"id": "managed-project"}
                        if case == "pro-object"
                        else "managed-project",
                    }
                )
            if case == "project-id":
                return web.json_response({"projectId": "managed-project"})
            if case == "project-object":
                return web.json_response({"project": {"id": "managed-project"}})
            if case == "catalog-absent":
                return web.json_response({})
            if case == "validation":
                return web.json_response(
                    {
                        "cloudaicompanionProject": "managed-project",
                        "ineligibleTiers": [{"reasonCode": "VALIDATION_REQUIRED"}],
                    }
                )
            if case in {"privacy", "terms"}:
                return web.json_response(
                    {
                        "allowedTiers": [{"id": "free-tier"}],
                        "privacyNoticeRequired" if case == "privacy" else "termsAcceptanceRequired": True,
                    }
                )
            if case in {"privacy-object", "terms-unaccepted"}:
                return web.json_response(
                    {
                        "allowedTiers": [{"id": "free-tier"}],
                        **(
                            {"privacyNotice": {"showNotice": True}}
                            if case == "privacy-object"
                            else {"hasAcceptedTos": False}
                        ),
                    }
                )
            return web.json_response(
                {
                    "allowedTiers": []
                    if case == "none-offered"
                    else [{"id": "standard-tier", "isDefault": True}]
                    if case == "non-free-advertised"
                    else [{"id": "free-tier"}]
                }
            )
        assert request.path == "/onboard"
        assert await request.json() == {
            "tier_id": "free-tier",
            "metadata": {"ide_type": "ANTIGRAVITY", "ide_version": antigravity.VERSION, "ide_name": "antigravity"},
        }
        assert request.headers["User-Agent"] == antigravity.ONBOARD_USER_AGENT
        if case == "pending":
            return web.json_response({"done": False, "name": "operations/pending"})
        if case == "non-free-advertised":
            return web.json_response({"error": {"message": "private-refresh"}}, status=403)
        if case == "failed":
            return web.json_response({"error": {"message": "private-refresh"}}, status=400)
        if case == "onboard-validation":
            return web.json_response({"done": True, "response": {"validationRequired": True}})
        return web.json_response({"done": True, "response": {"projectId": {"id": "managed-project"}}})

    await auth_upstream(handler)
    ticket, query = await _start(async_client)
    authorization.update(query)
    response = await async_client.post(
        "/api/model-sources/google/complete",
        json={
            "transaction": ticket,
            "code": _callback(query),
            "project": "must-not-be-sent",
            "allowFreeSetup": consent,
        },
    )
    assert observed.count("/onboard") == onboard_count
    for private in ("private-access", "private-refresh", "private-code", "fixture-private-secret", ticket):
        assert private not in response.text
    if not success:
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "google_setup_required"
        assert (await async_client.get("/api/model-sources/")).json()["sources"] == []
        if onboard_count:
            assert "attempted" in response.text and "No project or billing settings were changed" not in response.text
        return
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "gemini_antigravity"
    assert response.json()["baseUrl"] == antigravity.BASE_URL
    async with SessionLocal() as session:
        source = await session.get(ModelSource, response.json()["id"])
        assert source is not None and source.api_key_encrypted is not None
        assert b"private-refresh" not in source.api_key_encrypted
        credential = json.loads(TokenEncryptor().decrypt(source.api_key_encrypted))
    assert credential["project"] == "managed-project" and credential["quota_scope"] == "google-user:123"
    assert credential["client_id"] == "fixture-client" and credential["client_secret"] == "fixture-private-secret"
    assert credential["refresh_token"] == "private-refresh"


@pytest.mark.parametrize(
    "invalid",
    [
        "bare",
        "state",
        "duplicate-code",
        "duplicate-state",
        "host",
        "port",
        "path",
        "scheme",
        "userinfo",
        "fragment",
        "expired",
        "session",
        "tampered",
    ],
)
async def test_antigravity_callback_rejected_before_exchange(async_client, auth_upstream, invalid):
    reached = []

    async def handler(request):
        reached.append(request.path)
        return web.json_response({"error": "private-code"}, status=400)

    await auth_upstream(handler)
    ticket, query = await _start(async_client)
    callback = _callback(query)
    if invalid == "bare":
        callback = "private-code"
    elif invalid == "state":
        callback = callback.replace(query["state"][0], "wrong")
    elif invalid == "duplicate-code":
        callback += "&code=another"
    elif invalid == "duplicate-state":
        callback += "&state=" + query["state"][0]
    elif invalid in {"host", "port", "path", "scheme", "userinfo"}:
        old, new = {
            "host": ("localhost", "127.0.0.1"),
            "port": ("51121", "51122"),
            "path": ("oauth-callback", "other"),
            "scheme": ("http:", "https:"),
            "userinfo": ("localhost", "user@localhost"),
        }[invalid]
        callback = callback.replace(old, new)
    elif invalid == "fragment":
        callback += "#private"
    elif invalid == "expired":
        cipher = Fernet(get_or_create_key())
        ticket = cipher.encrypt_at_time(cipher.decrypt(ticket.encode()), int(time.time()) - 601).decode()
    elif invalid == "session":
        async_client.cookies.clear()
    elif invalid == "tampered":
        ticket = ticket[:-8] + "invalid!"
    result = await async_client.post(
        "/api/model-sources/google/complete", json={"transaction": ticket, "code": callback}
    )
    assert result.status_code == 400, result.text
    assert reached == []
    assert result.json()["error"]["code"] == (
        "invalid_google_transaction" if invalid in {"expired", "session", "tampered"} else "invalid_google_callback"
    )
    assert "private-code" not in result.text and ticket not in result.text


@pytest.mark.parametrize("missing", ["ID", "SECRET"])
async def test_antigravity_requires_server_client_on_start_and_complete(
    async_client, auth_upstream, monkeypatch, missing
):
    reached = []

    async def handler(request):
        reached.append(request.path)
        return web.json_response({})

    await auth_upstream(handler)
    ticket, query = await _start(async_client)
    monkeypatch.delenv("GEMINI_LB_ANTIGRAVITY_CLIENT_" + missing)
    get_settings.cache_clear()
    complete = await async_client.post(
        "/api/model-sources/google/complete", json={"transaction": ticket, "code": _callback(query)}
    )
    start = await async_client.post("/api/model-sources/google/start", json={"kind": "gemini_antigravity"})
    for result in (start, complete):
        assert result.status_code == 400, result.text
        assert result.json()["error"]["code"] == "google_client_not_configured"
        assert "fixture-private-secret" not in result.text
    assert reached == []
