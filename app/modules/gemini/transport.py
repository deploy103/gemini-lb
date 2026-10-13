from __future__ import annotations

import asyncio
import codecs
import hashlib
import json
import math
import re
import time
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from datetime import timezone
from email.utils import parsedate_to_datetime
from weakref import WeakValueDictionary

import aiohttp
from sqlalchemy import select, update

from app.core.clients.http import lease_model_source_session
from app.core.clock import REAL_SCHEDULER
from app.core.crypto import TokenEncryptor
from app.core.errors import google_error
from app.core.types import JsonValue
from app.core.utils.shared_future import _await_cleanup_deferring_cancellation, _await_task_deferring_cancellation
from app.core.utils.sse import extract_sse_data
from app.db.models import ModelSource
from app.db.session import get_background_session
from app.modules.gemini import antigravity
from app.modules.gemini.credentials import GoogleCredential, parse_google_credential
from app.modules.model_sources.forwarding import SourceResponsesStream, SourceStreamTransport, SourceUsageHolder

GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
MAX_GOOGLE_RESPONSE_BYTES = 16 * 1024 * 1024
_REFRESH_LOCKS: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
_RETRYABLE = frozenset({408, 429, 500, 502, 503, 504})


class GoogleError(Exception):
    def __init__(self, code: int, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after
        self.payload = google_error(code, message)

    @property
    def retryable(self) -> bool:
        return self.code in _RETRYABLE


def source_credential(source: ModelSource) -> GoogleCredential:
    try:
        return parse_google_credential(
            source.kind, TokenEncryptor().decrypt(source.api_key_encrypted) if source.api_key_encrypted else None
        )
    except ValueError:
        raise GoogleError(503, "Google source needs valid credentials; reimport it in Settings") from None


async def _read_json(response: aiohttp.ClientResponse, *, cap: int = MAX_GOOGLE_RESPONSE_BYTES) -> dict[str, JsonValue]:
    body = bytearray()
    async for chunk in response.content.iter_chunked(65536):
        body.extend(chunk)
        if len(body) > cap:
            raise GoogleError(502, "Google response exceeds the configured ingress safety bound")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        raise GoogleError(502, "Google returned an invalid JSON response") from None
    if not isinstance(payload, dict):
        raise GoogleError(502, "Google returned a non-object JSON response")
    return payload


def _redact(value: JsonValue, credential: GoogleCredential) -> JsonValue:
    if isinstance(value, str):
        for secret in (credential.api_key, credential.access_token, credential.refresh_token, credential.client_secret):
            if secret:
                value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, dict):
        return {key: _redact(item, credential) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item, credential) for item in value]
    return value


def upstream_error(
    code: int, payload: dict[str, JsonValue], credential: GoogleCredential, retry_after: str | None = None
) -> GoogleError:
    seconds = 0.0
    if retry_after:
        try:
            seconds = float(retry_after)
        except ValueError:
            try:
                date = parsedate_to_datetime(retry_after)
                seconds = date.replace(tzinfo=date.tzinfo or timezone.utc).timestamp() - time.time()
            except (ValueError, TypeError, OverflowError):
                pass
    error_body = payload.get("error")
    details = error_body.get("details") if isinstance(error_body, dict) else None
    if isinstance(details, list):
        for detail in details:
            if not isinstance(detail, dict):
                continue
            delay = detail.get("retryDelay")
            if isinstance(delay, str) and re.fullmatch(r"\d+(?:\.\d+)?s", delay):
                seconds = max(seconds, float(delay[:-1]))
            if re.search(r"perday|daily", json.dumps(detail), flags=re.IGNORECASE) and seconds <= 0:
                seconds = 86400
    seconds = min(max(0.0, seconds), 366 * 86400) if math.isfinite(seconds) else 0.0
    error = GoogleError(code, "Google upstream request failed", retry_after=seconds or (60 if code == 429 else 2))
    redacted = _redact(payload, credential)
    if isinstance(redacted, dict) and isinstance(redacted.get("error"), dict):
        error.payload = redacted
    return error


async def _refresh(source: ModelSource, credential: GoogleCredential) -> GoogleCredential:
    if not credential.refresh_token or not credential.client_id or not credential.client_secret:
        await _mark_reauth(source)
        raise GoogleError(401, "Google OAuth expired; reimport credentials with the matching OAuth client")
    async with lease_model_source_session() as http:
        async with http.post(
            GOOGLE_TOKEN_ENDPOINT,
            data={
                "grant_type": "refresh_token",
                "refresh_token": credential.refresh_token,
                "client_id": credential.client_id,
                "client_secret": credential.client_secret,
            },
            timeout=aiohttp.ClientTimeout(total=15, connect=10),
            allow_redirects=False,
        ) as response:
            payload = await _read_json(response, cap=1024 * 1024)
            if response.status != 200:
                if payload.get("error") in ("invalid_grant", "invalid_client", "unauthorized_client"):
                    await _mark_reauth(source)
                    raise GoogleError(401, "Google OAuth requires credential reimport")
                raise GoogleError(503, "Google OAuth refresh failed; check the imported user and OAuth client")
    token, expiry = payload.get("access_token"), payload.get("expires_in")
    if (
        not isinstance(token, str)
        or not token
        or not isinstance(expiry, (int, float))
        or isinstance(expiry, bool)
        or not math.isfinite(expiry)
        or expiry <= 0
    ):
        raise GoogleError(502, "Google returned an invalid OAuth token response")
    refreshed = credential.model_copy(update={"access_token": token, "expiry_date": time.time() * 1000 + expiry * 1000})
    refresh_token = payload.get("refresh_token")
    if isinstance(refresh_token, str) and refresh_token:
        refreshed.refresh_token = refresh_token
    encrypted = TokenEncryptor().encrypt(refreshed.model_dump_json(exclude_none=True))
    async with get_background_session() as session:
        changed = await session.scalar(
            update(ModelSource)
            .where(
                ModelSource.id == source.id,
                ModelSource.api_key_encrypted == source.api_key_encrypted,
                ModelSource.is_enabled.is_(True),
            )
            .values(api_key_encrypted=encrypted, health_status="unknown")
            .returning(ModelSource.id)
        )
        await session.commit()
    if changed is None:
        raise GoogleError(
            503, "Google source changed during refresh; retry against the operator's current configuration"
        )
    source.api_key_encrypted = encrypted
    return refreshed


async def _mark_reauth(source: ModelSource) -> None:
    async with get_background_session() as session:
        await session.execute(
            update(ModelSource)
            .where(
                ModelSource.id == source.id,
                ModelSource.api_key_encrypted == source.api_key_encrypted,
            )
            .values(health_status="reauth_required")
        )
        await session.commit()


async def _current_oauth(source: ModelSource) -> GoogleCredential:
    lock = _REFRESH_LOCKS.setdefault(source.id, asyncio.Lock())
    async with lock:
        # Another request may already have refreshed, or an operator may have
        # replaced/disabled this source while this request waited for the lock.
        async with get_background_session() as session:
            encrypted = await session.scalar(
                select(ModelSource.api_key_encrypted).where(
                    ModelSource.id == source.id, ModelSource.is_enabled.is_(True)
                )
            )
        if encrypted is None:
            raise GoogleError(503, "Google source is no longer enabled")
        source.api_key_encrypted = encrypted
        credential = source_credential(source)
        margin = 60000 if credential.refresh_token else 0
        if credential.access_token and (credential.expiry_date or 0) > time.time() * 1000 + margin:
            return credential
        # Own the refresh even when its initiating HTTP request disconnects:
        # rotating Google credentials must finish persistence before teardown.
        task = asyncio.create_task(_refresh(source, credential))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            await _await_task_deferring_cancellation(task)
            raise


async def open_google(
    source: ModelSource, path: str, payload: dict[str, JsonValue] | None
) -> tuple[AsyncExitStack, aiohttp.ClientResponse, GoogleCredential]:
    stack = AsyncExitStack()
    try:
        credential = source_credential(source) if source.kind == "gemini_api_key" else await _current_oauth(source)
        headers = {"content-type": "application/json"}
        if source.kind == "gemini_api_key":
            headers["x-goog-api-key"] = credential.api_key or ""
        else:
            headers["authorization"] = f"Bearer {credential.access_token}"
            if source.kind == "gemini_antigravity":
                headers["user-agent"] = antigravity.USER_AGENT
            if payload is not None:
                payload = json.loads(json.dumps(payload))
                if (
                    (source.kind == "gemini_antigravity" and "countTokens" not in path)
                    or "project" in payload
                    or any(
                        method in path
                        for method in (
                            "generateContent",
                            "streamGenerateContent",
                            "retrieveUserQuota",
                        )
                    )
                ):
                    payload["project"] = credential.project
                if source.kind == "gemini_antigravity":
                    inner = payload.get("request")
                    if isinstance(inner, dict):
                        session_id = inner.pop("session_id", None)
                        if isinstance(session_id, str) and "countTokens" not in path:
                            inner["sessionId"] = str(int(hashlib.sha256(session_id.encode()).hexdigest()[:15], 16))
                if "loadCodeAssist" in path and source.kind != "gemini_antigravity":
                    payload["cloudaicompanionProject"] = credential.project
                    metadata = payload.setdefault("metadata", {})
                    if isinstance(metadata, dict):
                        metadata["duetProject"] = credential.project
                if source.kind != "gemini_antigravity" and isinstance(payload.get("metadata"), dict):
                    payload["metadata"]["duetProject"] = credential.project
        http = await stack.enter_async_context(lease_model_source_session())
        response = await stack.enter_async_context(
            http.request(
                "GET" if payload is None else "POST",
                source.base_url.rstrip("/") + path,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=source.timeout_seconds or 600, connect=10, sock_read=60),
                allow_redirects=False,
            )
        )
        if response.status >= 300:
            try:
                body = await _read_json(response)
            except GoogleError:
                body = google_error(response.status, "Google upstream rejected the request")
            if response.status == 401:
                await _mark_reauth(source)
            raise upstream_error(response.status, body, credential, response.headers.get("Retry-After"))
        return stack, response, credential
    except (aiohttp.ClientError, TimeoutError):
        await _await_cleanup_deferring_cancellation(stack.aclose())
        raise GoogleError(503, "Google upstream timed out or could not be reached", retry_after=2) from None
    except BaseException:
        await _await_cleanup_deferring_cancellation(stack.aclose())
        raise


async def google_json(source: ModelSource, path: str, payload: dict[str, JsonValue] | None) -> dict[str, JsonValue]:
    stack, response, credential = await open_google(source, path, payload)
    try:
        result = await _read_json(response)
        if isinstance(result.get("error"), dict):
            raise upstream_error(502, result, credential)
        if "retrieveUserQuota" in path:
            buckets = result.get("buckets")
            if (
                not isinstance(buckets, list)
                or len(buckets) > 500
                or any(not isinstance(bucket, dict) for bucket in buckets)
            ):
                raise GoogleError(502, "Google returned an invalid quota snapshot")
            fields = {"modelId", "remainingFraction", "remainingAmount", "resetTime", "tokenType"}
            result["buckets"] = [
                {key: value for key, value in bucket.items() if key in fields and value is not None}
                for bucket in buckets
                if isinstance(bucket, dict)
            ]
            for bucket in result["buckets"]:
                if not isinstance(bucket, dict):
                    continue
                fraction = bucket.get("remainingFraction")
                if fraction is not None and (
                    not isinstance(fraction, (int, float)) or isinstance(fraction, bool) or not 0 <= fraction <= 1
                ):
                    raise GoogleError(502, "Google returned an invalid quota fraction")
                if any(not isinstance(value, str) for key, value in bucket.items() if key != "remainingFraction"):
                    raise GoogleError(502, "Google returned an invalid quota bucket")
        if (
            "loadCodeAssist" in path
            and source.kind == "gemini_code_assist"
            and (
                not isinstance(result.get("currentTier"), dict)
                or antigravity.account_project(result) not in (None, credential.project)
            )
        ):
            raise GoogleError(
                409, "Google account/project is not onboarded or mismatched; use the official Gemini CLI first"
            )
        return result
    except (aiohttp.ClientError, TimeoutError):
        raise GoogleError(503, "Google response transport failed", retry_after=2) from None
    finally:
        await _await_cleanup_deferring_cancellation(stack.aclose())


async def _google_frames(response: aiohttp.ClientResponse) -> AsyncIterator[str]:
    decoder = codecs.getincrementaldecoder("utf-8")()
    buffer, cr_pending, bom_pending = "", False, True
    async for chunk in response.content.iter_chunked(8192):
        text = decoder.decode(chunk)
        if cr_pending and text:
            text = text.removeprefix("\n")
            cr_pending = False
        if text:
            cr_pending = text.endswith("\r")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        if bom_pending and text:
            text = text.removeprefix("\ufeff")
            bom_pending = False
        buffer += text
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            if len(frame.encode()) > MAX_GOOGLE_RESPONSE_BYTES:
                raise GoogleError(502, "Google SSE frame exceeded the safety bound")
            if extract_sse_data(frame) is not None:
                yield frame + "\n\n"
        if len(buffer.encode()) > MAX_GOOGLE_RESPONSE_BYTES:
            raise GoogleError(502, "Google SSE frame exceeded the safety bound")
    buffer += decoder.decode(b"", final=True)
    if buffer.strip():
        raise GoogleError(502, "Google SSE stream ended inside an event")


def frame_payload(frame: str, credential: GoogleCredential) -> dict[str, JsonValue]:
    try:
        payload = json.loads(extract_sse_data(frame) or "")
    except ValueError:
        raise GoogleError(502, "Google SSE stream contains invalid JSON") from None
    if not isinstance(payload, dict):
        raise GoogleError(502, "Google SSE stream contains a non-object event")
    if isinstance(payload.get("error"), dict):
        code = payload["error"].get("code")
        raise upstream_error(code if type(code) is int and 400 <= code <= 599 else 502, payload, credential)
    return payload


async def google_stream(
    source: ModelSource, path: str, payload: dict[str, JsonValue]
) -> tuple[SourceResponsesStream, GoogleCredential]:
    stack, response, credential = await open_google(source, path, payload)
    transport = SourceStreamTransport(stack, scheduler=REAL_SCHEDULER)
    try:
        if response.headers.get("content-type", "").split(";", 1)[0].strip() != "text/event-stream":
            raise GoogleError(502, "Google streaming response is not SSE")
        frames = _google_frames(response)
        first = await anext(frames)
        frame_payload(first, credential)

        async def body() -> AsyncIterator[bytes]:
            try:
                yield first.encode()
                async for frame in frames:
                    yield frame.encode()
            finally:
                await transport.aclose()

        return SourceResponsesStream(
            body=body(), usage_holder=SourceUsageHolder(), upstream_status_code=response.status, transport=transport
        ), credential
    except (StopAsyncIteration, aiohttp.ClientError, TimeoutError, UnicodeError):
        await transport.aclose()
        raise GoogleError(503, "Google stream ended before its first valid event", retry_after=2) from None
    except BaseException:
        await transport.aclose()
        raise
