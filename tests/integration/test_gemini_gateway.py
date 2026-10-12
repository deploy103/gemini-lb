"""Native Google requests through the retained control plane and real HTTP upstream."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from datetime import datetime, timedelta

import pytest
from aiohttp import web
from sqlalchemy import select

from app.core.crypto import TokenEncryptor
from app.db.models import ApiKeyUsageReservation, GeminiSession, ModelSource, RequestLog
from app.db.session import SessionLocal
from tests.integration.model_source_helpers import _AsgiStream, stub_source_upstreams

pytestmark = pytest.mark.integration
MODEL = "gemini-2.5-flash"
BODY = {"contents": [{"role": "user", "parts": [{"text": "hello"}]}]}
RESULT = {
    "candidates": [{"index": 0, "content": {"parts": [{"text": "안녕"}]}, "finishReason": "STOP"}],
    "usageMetadata": {
        "promptTokenCount": 31,
        "candidatesTokenCount": 7,
        "thoughtsTokenCount": 5,
        "cachedContentTokenCount": 11,
        "totalTokenCount": 43,
    },
}


@pytest.fixture
async def google_upstream():
    async with stub_source_upstreams() as start:
        yield start


async def _source(client, base_url, name="google", *, kind="gemini_api_key", credential=None):
    response = await client.post(
        "/api/model-sources/",
        json={
            "name": name,
            "kind": kind,
            "baseUrl": base_url.removesuffix("/v1"),
            "apiKey": credential or f"upstream-{name}",
            "maxConcurrency": 2,
            "models": [
                {"model": MODEL, "supportsStreaming": True, "inputPer1M": 2, "cachedInputPer1M": 0.5, "outputPer1M": 6}
            ],
        },
    )
    assert response.status_code == 200, response.text
    assert "upstream-" not in response.text
    return response.json()["id"]


async def _key(client, **policy):
    response = await client.post(
        "/api/api-keys/",
        json={
            "name": "google-client",
            "allowedModels": [MODEL],
            "limits": [{"limitType": "total_tokens", "limitWindow": "weekly", "maxValue": 100_000}],
            **policy,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(
    "version,header,method",
    [
        ("v1beta", "x-goog-api-key", "generateContent"),
        ("v1", "x-gemini-lb-key", "generateContent"),
        ("gemini/v1", "authorization", "countTokens"),
        ("v1beta", "authorization", "embedContent"),
        ("gemini/v1beta", "x-goog-api-key", "batchEmbedContents"),
    ],
)
async def test_google_native_auth_paths_and_usage(async_client, google_upstream, version, header, method):
    observed = []

    async def handler(request):
        observed.append((request.path_qs, dict(request.headers), await request.json()))
        return web.json_response(RESULT)

    source_id = await _source(async_client, await google_upstream(handler))
    key = await _key(async_client)
    token = f"Bearer {key['key']}" if header == "authorization" else key["key"]
    response = await async_client.post(
        f"/{version}/models/{MODEL}:{method}/?key=DO-NOT-FORWARD",
        headers={header: token, "X-Arbitrary": "private"},
        json=BODY,
    )
    assert response.status_code == 200, response.text
    assert response.json() == RESULT
    assert response.headers["x-gemini-lb-account"] == source_id
    path, headers, body = observed[0]
    assert path == f"/{version.removeprefix('gemini/')}/models/{MODEL}:{method}"
    assert headers["x-goog-api-key"] == "upstream-google"
    assert "authorization" not in {name.lower() for name in headers}
    assert "X-Arbitrary" not in headers and body == BODY
    async with SessionLocal() as session:
        reservations = list((await session.scalars(select(ApiKeyUsageReservation))).all())
        row = await session.scalar(select(RequestLog).where(RequestLog.model_source_id == source_id))
    assert len(reservations) == 1 and reservations[0].status == "finalized"
    expected_input, expected_output = (0, 0) if method == "countTokens" else (31, 12)
    assert (reservations[0].input_tokens, reservations[0].output_tokens) == (expected_input, expected_output)
    assert row is not None and (row.input_tokens, row.output_tokens) == (expected_input, expected_output)
    # (31 - 11) × $2/M + 11 × $0.5/M + (7 + 5) × $6/M = $0.0001175.
    assert reservations[0].cost_microdollars == (0 if method == "countTokens" else 117)


async def test_google_catalog_filters_without_replacing_openai_catalog(async_client, google_upstream):
    async def handler(request):
        assert request.method == "GET"
        return web.json_response({"models": [{"name": f"models/{MODEL}"}, {"name": "models/other"}]})

    await _source(async_client, await google_upstream(handler))
    key = await _key(async_client)
    for path in ("/v1beta/models", "/v1/models/", "/gemini/v1/models"):
        response = await async_client.get(path, headers={"x-goog-api-key": key["key"]})
        assert response.status_code == 200, response.text
        assert response.json() == {"models": [{"name": f"models/{MODEL}"}]}
    openai = await async_client.get("/v1/models", headers={"Authorization": f"Bearer {key['key']}"})
    assert openai.status_code == 200 and openai.json()["object"] == "list"


async def test_google_rejects_unauthorized_models_sources_resources_and_capabilities(async_client, google_upstream):
    observed = []

    async def handler(request):
        observed.append(request.path)
        return web.json_response(RESULT)

    source_id = await _source(async_client, await google_upstream(handler))
    assigned = await _source(async_client, await google_upstream(handler), "assigned-only")
    key = await _key(async_client, assignedSourceIds=[assigned])
    deleted = await async_client.delete(f"/api/model-sources/{assigned}")
    assert deleted.status_code == 204
    path = f"/v1beta/models/{MODEL}:generateContent"
    denied = await async_client.post(path, headers={"x-goog-api-key": key["key"]}, json=BODY)
    assert denied.status_code == 503
    pinned = await async_client.post(
        path, headers={"x-goog-api-key": key["key"], "x-gemini-lb-account": source_id}, json=BODY
    )
    assert pinned.status_code == 403
    key = await _key(async_client)
    for headers in (
        {},
        {"x-goog-api-key": key["key"], "authorization": "Bearer conflict"},
        [("x-goog-api-key", key["key"]), ("x-goog-api-key", key["key"])],
    ):
        response = await async_client.post(path, headers=headers, json=BODY)
        assert response.status_code == 401 and response.json()["error"]["status"] == "UNAUTHENTICATED"
    forbidden = await async_client.post(path.replace(MODEL, "other"), headers={"x-goog-api-key": key["key"]}, json=BODY)
    assert forbidden.status_code == 403
    resource = await async_client.post(
        path, headers={"x-goog-api-key": key["key"]}, json={**BODY, "cachedContent": "cachedContents/owned"}
    )
    assert resource.status_code == 409
    capability = await async_client.post(
        path, headers={"x-goog-api-key": key["key"], "x-codex-lb-required-capability": "images"}, content=b"not-json"
    )
    assert capability.status_code == 400, capability.text
    assert capability.json()["error"]["status"] == "INVALID_ARGUMENT"
    unknown = await async_client.get("/v1beta/files", headers={"x-goog-api-key": key["key"]})
    assert unknown.status_code == 501 and unknown.json()["error"]["status"] == "UNIMPLEMENTED"
    health = await async_client.get("/healthz")
    assert health.status_code == 200 and health.json()["status"] == "ok" and isinstance(health.json()["version"], str)
    assert observed == []


async def test_google_failover_cooldown_and_durable_session_pin(async_client, google_upstream):
    hits = []

    async def depleted(request):
        hits.append("depleted")
        return web.json_response(
            {"error": {"code": 429, "message": "upstream-depleted secret"}}, status=429, headers={"Retry-After": "60"}
        )

    async def healthy(request):
        hits.append("healthy")
        return web.json_response(RESULT)

    first = await _source(async_client, await google_upstream(depleted), "depleted")
    second = await _source(async_client, await google_upstream(healthy), "healthy")
    # Use public source IDs rather than relying on UUID ordering for the scenario.
    async with SessionLocal() as session:
        old = await session.get(ModelSource, first)
        assert old is not None
        session.add(
            RequestLog(
                account_id=None,
                request_id="previous-healthy",
                model_source_id=second,
                model=MODEL,
                status="success",
                requested_at=datetime.now(),
            )
        )
        await session.commit()
    key = await _key(async_client)
    path = f"/v1beta/models/{MODEL}:generateContent"
    response = await async_client.post(path, headers={"x-goog-api-key": key["key"]}, json=BODY)
    assert response.status_code == 200 and hits == ["depleted", "healthy"]
    assert response.headers["x-gemini-lb-account"] == second
    hits.clear()
    session_headers = {"x-goog-api-key": key["key"], "x-gemini-lb-session": "turns"}
    response = await async_client.post(path, headers=session_headers, json=BODY)
    assert response.status_code == 200 and response.headers["x-gemini-lb-account"] == second
    changed = await async_client.patch(f"/api/model-sources/{second}", json={"isEnabled": False})
    assert changed.status_code == 200
    # Ownership is read from persistence, not a process-local sticky cache.
    response = await async_client.post(path, headers=session_headers, json=BODY)
    assert response.status_code == 503 and hits == ["healthy"]
    conflict = await async_client.post(path, headers={**session_headers, "x-gemini-lb-account": first}, json=BODY)
    assert conflict.status_code == 409
    async with SessionLocal() as session:
        reservations = list((await session.scalars(select(ApiKeyUsageReservation))).all())
    assert sorted(row.status for row in reservations) == ["finalized", "finalized", "released"]


@pytest.mark.parametrize("terminal", [True, False])
async def test_google_stream_usage_and_no_replay_after_output(async_client, google_upstream, terminal):
    hits = []

    async def handler(request):
        hits.append(request.path_qs)
        assert request.query == {"alt": "sse"}
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        frame = {**RESULT, "candidates": [{"index": 0, "content": {"parts": [{"text": "안녕"}]}}]}
        if terminal:
            frame = RESULT
        # Real transport exercises split UTF-8, BOM and CRLF normalization.
        encoded = ("\ufeffdata: " + json.dumps(frame, ensure_ascii=False) + "\r\n\r\n").encode()
        for index in range(0, len(encoded), 7):
            await response.write(encoded[index : index + 7])
        await response.write_eof()
        return response

    source_id = await _source(async_client, await google_upstream(handler))
    key = await _key(async_client)
    response = await async_client.post(
        f"/v1beta/models/{MODEL}:streamGenerateContent?alt=sse", headers={"x-goog-api-key": key["key"]}, json=BODY
    )
    assert response.status_code == 200 and "안녕" in response.text and len(hits) == 1
    assert ('"error"' in response.text) is not terminal
    async with SessionLocal() as session:
        reservation = await session.scalar(select(ApiKeyUsageReservation))
        row = await session.scalar(select(RequestLog).where(RequestLog.model_source_id == source_id))
    assert reservation is not None and reservation.status == "finalized"
    assert (reservation.input_tokens, reservation.output_tokens) == (31, 12)
    assert row is not None and row.status == ("success" if terminal else "error")


async def test_google_disconnect_settles_delivered_usage(async_client, google_upstream):
    async def handler(request):
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(f"data: {json.dumps(RESULT)}\n\n".encode())
        await asyncio.Event().wait()
        return response

    base = await google_upstream(handler, handler_cancellation=True, shutdown_timeout=0.1)
    await _source(async_client, base)
    key = await _key(async_client)
    stream = _AsgiStream(
        app=async_client._transport.app,
        path=f"/v1beta/models/{MODEL}:streamGenerateContent?alt=sse",
        headers={"x-goog-api-key": key["key"]},
        body=json.dumps(BODY).encode(),
    )
    task = asyncio.create_task(stream.run())
    try:
        await stream.wait_for_text("data:")
        stream.disconnect()
        await asyncio.wait_for(task, 5)
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    async with SessionLocal() as session:
        reservation = await session.scalar(select(ApiKeyUsageReservation))
    assert reservation is not None and reservation.status == "finalized"
    assert (reservation.input_tokens, reservation.output_tokens) == (31, 12)


async def test_code_assist_refresh_persists_identity_and_overrides_client_project(
    async_client, google_upstream, monkeypatch
):
    from app.modules.gemini import transport

    refreshed, observed = [], []

    async def handler(request):
        if request.path == "/token":
            refreshed.append(dict(await request.post()))
            return web.json_response(
                {"access_token": "fresh-token", "refresh_token": "rotated-token", "expires_in": 3600}
            )
        body = await request.json()
        observed.append((request.headers.get("authorization"), body))
        return web.json_response({"response": RESULT})

    base = await google_upstream(handler)
    monkeypatch.setattr(transport, "GOOGLE_TOKEN_ENDPOINT", base.removesuffix("/v1") + "/token")
    credential = json.dumps(
        {
            "access_token": "expired-token",
            "expiry_date": time.time() * 1000 - 1000,
            "refresh_token": "original-token",
            "client_id": "client",
            "client_secret": "secret",
            "project": "operator-project",
        }
    )
    source_id = await _source(async_client, base, kind="gemini_code_assist", credential=credential)
    key = await _key(async_client)
    responses = await asyncio.gather(
        *(
            async_client.post(
                "/v1internal:generateContent",
                headers={"x-gemini-lb-key": key["key"], "Authorization": "Bearer client-google-token"},
                json={"model": MODEL, "project": "attacker-project", "request": BODY},
            )
            for _ in range(2)
        )
    )
    for response in responses:
        assert response.status_code == 200, response.text
    assert len(refreshed) == 1 and refreshed[0]["refresh_token"] == "original-token"
    assert all(header == "Bearer fresh-token" and body["project"] == "operator-project" for header, body in observed)
    async with SessionLocal() as session:
        source = await session.get(ModelSource, source_id)
        assert source is not None and source.api_key_encrypted is not None
        stored = json.loads(TokenEncryptor().decrypt(source.api_key_encrypted))
    assert stored["refresh_token"] == "rotated-token" and stored["quota_scope"]
    listed = await async_client.get("/api/model-sources/")
    assert "fresh-token" not in listed.text and "rotated-token" not in listed.text


async def test_google_quota_refresh_persists_and_gates_matching_model(async_client, google_upstream):
    snapshot = {"buckets": [{"modelId": MODEL, "remainingFraction": 0.0, "resetTime": "2100-01-01T00:00:00Z"}]}
    observed = []

    async def handler(request):
        observed.append((request.path, await request.json()))
        if request.path.endswith("retrieveUserQuota"):
            return web.json_response(snapshot)
        return web.json_response({"response": RESULT})

    credential = json.dumps(
        {"project": "project", "access_token": "access", "expiry_date": time.time() * 1000 + 3600000}
    )
    source_id = await _source(
        async_client, await google_upstream(handler), kind="gemini_code_assist", credential=credential
    )
    endpoint = f"/api/model-sources/{source_id}/quota"
    assert (await async_client.get(endpoint)).json() == {"buckets": [], "updatedAt": None}
    refreshed = await async_client.post(endpoint)
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["buckets"] == snapshot["buckets"] and refreshed.json()["updatedAt"]
    assert observed[0][1]["project"] == "project"
    assert (await async_client.get(endpoint)).json()["buckets"] == snapshot["buckets"]
    key = await _key(async_client)
    arguments = dict(headers={"x-gemini-lb-key": key["key"]}, json={"model": MODEL, "request": BODY})
    denied = await async_client.post("/v1internal:generateContent", **arguments)
    assert denied.status_code == 503 and len(observed) == 1
    snapshot["buckets"][0]["remainingFraction"] = 0.37
    assert (await async_client.post(endpoint)).status_code == 200
    assert (await async_client.post("/v1internal:generateContent", **arguments)).status_code == 200
    snapshot["buckets"][0]["remainingFraction"] = True
    assert (await async_client.post(endpoint)).status_code == 400
    assert (await async_client.get(endpoint)).json()["buckets"][0]["remainingFraction"] == 0.37


async def test_google_refresh_does_not_overwrite_operator_reimport(async_client, google_upstream, monkeypatch):
    from app.modules.gemini import transport

    entered, resume = asyncio.Event(), asyncio.Event()
    headers_seen = []

    async def handler(request):
        if request.path == "/token":
            entered.set()
            await resume.wait()
            return web.json_response({"access_token": "stale-refresh-result", "expires_in": 3600})
        headers_seen.append(request.headers.get("authorization"))
        return web.json_response({"response": RESULT})

    base = await google_upstream(handler)
    monkeypatch.setattr(transport, "GOOGLE_TOKEN_ENDPOINT", base.removesuffix("/v1") + "/token")
    old = {"project": "project", "refresh_token": "old", "client_id": "id", "client_secret": "secret"}
    source_id = await _source(async_client, base, kind="gemini_code_assist", credential=json.dumps(old))
    key = await _key(async_client)
    arguments = dict(headers={"x-gemini-lb-key": key["key"]}, json={"model": MODEL, "request": BODY})
    task = asyncio.create_task(async_client.post("/v1internal:generateContent", **arguments))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        replacement = {
            "project": "replacement-project",
            "access_token": "operator-token",
            "expiry_date": time.time() * 1000 + 3600000,
        }
        changed = await async_client.patch(f"/api/model-sources/{source_id}", json={"apiKey": json.dumps(replacement)})
        assert changed.status_code == 200
        resume.set()
        assert (await asyncio.wait_for(task, 5)).status_code == 503
    finally:
        resume.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    async with SessionLocal() as session:
        source = await session.get(ModelSource, source_id)
        assert source is not None and source.api_key_encrypted is not None
        assert json.loads(TokenEncryptor().decrypt(source.api_key_encrypted))["access_token"] == "operator-token"
    assert headers_seen == []


async def test_google_legacy_session_keeps_its_original_owner(async_client, google_upstream):
    observed = []

    async def handler(request):
        observed.append(request.path)
        return web.json_response(RESULT)

    source_id = await _source(async_client, await google_upstream(handler))
    await _source(async_client, await google_upstream(handler), "alternative")
    key = await _key(async_client)
    async with SessionLocal() as session:
        session.add(
            GeminiSession(
                session_hash=hashlib.sha256(f"{key['id']}\0legacy-session".encode()).hexdigest(),
                source_id=source_id,
                expires_at=datetime.now() + timedelta(hours=1),
            )
        )
        await session.commit()
    arguments = dict(headers={"x-goog-api-key": key["key"], "x-gemini-lb-session": "legacy-session"}, json=BODY)
    result = await async_client.post(f"/v1beta/models/{MODEL}:generateContent", **arguments)
    assert result.status_code == 200 and result.headers["x-gemini-lb-account"] == source_id
    assert (await async_client.delete(f"/api/model-sources/{source_id}")).status_code == 204
    refused = await async_client.post(f"/v1beta/models/{MODEL}:generateContent", **arguments)
    assert refused.status_code == 503 and len(observed) == 1


async def test_google_reauthentication_requires_reimport(async_client, google_upstream):
    reject, observed = True, []

    async def handler(request):
        observed.append(request.path)
        if reject:
            return web.Response(status=401, text="invalid upstream credential")
        return web.json_response(RESULT)

    source_id = await _source(async_client, await google_upstream(handler))
    key = await _key(async_client)
    arguments = dict(headers={"x-goog-api-key": key["key"]}, json=BODY)
    path = f"/v1beta/models/{MODEL}:generateContent"
    assert (await async_client.post(path, **arguments)).status_code == 401
    listed = (await async_client.get("/api/model-sources/")).json()["sources"]
    assert next(source for source in listed if source["id"] == source_id)["healthStatus"] == "reauth_required"
    assert (await async_client.post(path, **arguments)).status_code == 503 and len(observed) == 1
    reject = False
    assert (
        await async_client.patch(f"/api/model-sources/{source_id}", json={"apiKey": "replacement-key"})
    ).status_code == 200
    assert (await async_client.post(path, **arguments)).status_code == 200 and len(observed) == 2
