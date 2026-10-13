from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import AsyncIterator
from urllib.parse import urlencode
from uuid import uuid4

import aiohttp
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from starlette.routing import Match
from starlette.types import Scope

from app.core.auth.dependencies import validate_required_google_api_key
from app.core.exceptions import AppError, ProxyAuthError
from app.core.types import JsonValue
from app.core.utils.time import utcnow
from app.db.models import ModelSource
from app.db.session import get_background_session
from app.modules.api_keys.repository import ApiKeysRepository
from app.modules.api_keys.service import (
    API_KEY_USAGE_RESERVATION_DEFAULT_OUTPUT_TOKENS,
    ApiKeyData,
    ApiKeyInvalidError,
    ApiKeyRateLimitExceededError,
    ApiKeyRequestUsageBudget,
    ApiKeysService,
    ApiKeyUsageReservationData,
)
from app.modules.gemini import antigravity
from app.modules.gemini.credentials import GoogleCredential
from app.modules.gemini.repository import claim_session, eligible_sources, lookup_session, save_quota, set_cooldown
from app.modules.gemini.transport import GoogleError, frame_payload, google_json, google_stream, source_credential
from app.modules.model_sources.forwarding import SourceUsage
from app.modules.model_sources.selection import allowed_source_ids_for_api_key
from app.modules.proxy.source_admission import get_source_bulkhead, try_claim
from app.modules.proxy.source_dispatch import (
    ClientDisconnectedDuringOpen,
    SourceDispatch,
    SourceStreamingResponse,
    open_with_disconnect_watch,
)

_MODEL = re.compile(r"[a-zA-Z0-9._-]{1,128}\Z")
_NATIVE_METHODS = frozenset(
    {"generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents"}
)
_ASSIST_METHODS = frozenset(
    {
        "generateContent",
        "streamGenerateContent",
        "countTokens",
        "loadCodeAssist",
        "retrieveUserQuota",
        "fetchAdminControls",
        "listExperiments",
        "recordCodeAssistMetrics",
    }
)
_RESOURCE_FIELDS = frozenset(
    {"cachedContent", "cached_content", "fileData", "file_data", "thoughtSignature", "thought_signature"}
)


class GoogleCatalogRoute(APIRoute):
    def matches(self, scope: Scope) -> tuple[Match, Scope]:
        # /v1/models is shared with the retained OpenAI/Codex catalog. Native
        # SDK headers select Google explicitly; Bearer-only clients can use
        # /gemini/v1/models without changing the old OpenAI contract.
        if scope.get("path", "").rstrip("/") == "/v1/models":
            names = {name.lower() for name, _ in scope.get("headers", [])}
            if not names.intersection({b"x-goog-api-key", b"x-gemini-lb-key"}):
                return Match.NONE, {}
        return super().matches(scope)


router = APIRouter(tags=["gemini"], route_class=GoogleCatalogRoute)


async def authenticate_google(request: Request) -> ApiKeyData:
    try:
        return await validate_required_google_api_key(request)
    except ProxyAuthError as error:
        raise GoogleError(error.status_code, error.message) from None


def error_response(error: GoogleError) -> JSONResponse:
    return JSONResponse(
        status_code=error.code,
        content=error.payload,
        headers={"Retry-After": str(max(1, math.ceil(error.retry_after)))} if error.retry_after else None,
    )


def _has_resource(value: JsonValue) -> bool:
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            if any(name in _RESOURCE_FIELDS and child is not None and child != "" for name, child in item.items()):
                return True
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    return False


def _body_response(payload: dict[str, JsonValue]) -> dict[str, JsonValue]:
    response = payload.get("response")
    return response if isinstance(response, dict) else payload


def _usage(payload: dict[str, JsonValue]) -> SourceUsage | None:
    metadata = _body_response(payload).get("usageMetadata")
    if not isinstance(metadata, dict):
        return None
    prompt = metadata.get("promptTokenCount")
    total = metadata.get("totalTokenCount")
    candidates = metadata.get("candidatesTokenCount", 0)
    thoughts = metadata.get("thoughtsTokenCount", 0)
    cached = metadata.get("cachedContentTokenCount", 0)
    if type(prompt) is not int or prompt < 0:
        return None
    if (
        not isinstance(candidates, int)
        or isinstance(candidates, bool)
        or candidates < 0
        or not isinstance(thoughts, int)
        or isinstance(thoughts, bool)
        or thoughts < 0
        or not isinstance(cached, int)
        or isinstance(cached, bool)
        or cached < 0
    ):
        return None
    output = candidates + thoughts
    if output == 0 and type(total) is int and total >= prompt:
        output = total - prompt
    return SourceUsage(
        input_tokens=prompt, output_tokens=output, cached_input_tokens=min(prompt, cached), reasoning_tokens=thoughts
    )


async def _release(reservation: ApiKeyUsageReservationData | None) -> None:
    if reservation is not None:
        async with get_background_session() as session:
            await ApiKeysService(ApiKeysRepository(session)).release_usage_reservation(reservation.reservation_id)


async def _settle(
    reservation: ApiKeyUsageReservationData | None,
    *,
    source: ModelSource,
    model: str,
    usage: SourceUsage | None,
    cost_usd_override: float | None = None,
) -> bool:
    del source
    if reservation is None:
        return True
    if usage is None:
        await _release(reservation)
        return True
    try:
        async with get_background_session() as session:
            await ApiKeysService(ApiKeysRepository(session)).finalize_usage_reservation(
                reservation.reservation_id,
                model=model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cached_input_tokens=usage.cached_input_tokens,
                cost_microdollars=int((cost_usd_override or 0) * 1_000_000),
            )
        return True
    except Exception:
        await _release(reservation)
        return False


async def _open_stream(owner: SourceDispatch, path: str, body: dict[str, JsonValue]) -> GoogleCredential:
    stream, credential = await google_stream(owner.source, path, body)
    owner.stream = stream
    return credential


async def _stream_body(
    owner: SourceDispatch, credential: GoogleCredential, expected_candidates: int
) -> AsyncIterator[str]:
    owner.body_started = True
    stream = owner.stream
    if stream is None:
        raise RuntimeError("Google stream has no transport owner")
    holder = stream.usage_holder
    seen, finished = set(), set()
    try:
        async for raw in stream.body:
            frame = raw.decode()
            payload = frame_payload(frame, credential)
            response = _body_response(payload)
            if holder.first_frame_at is None:
                holder.first_frame_at = owner.clock.monotonic()
            usage = _usage(payload)
            if usage is not None:
                holder.usage = usage
            response_id = response.get("responseId")
            if isinstance(response_id, str):
                holder.response_id = response_id
            candidates = response.get("candidates")
            delivered = False
            if isinstance(candidates, list):
                for index, candidate in enumerate(candidates):
                    if not isinstance(candidate, dict):
                        continue
                    candidate_index = candidate.get("index", index)
                    if type(candidate_index) is not int:
                        raise GoogleError(502, "Google stream has an invalid candidate index")
                    seen.add(candidate_index)
                    if candidate.get("finishReason"):
                        finished.add(candidate_index)
                    content = candidate.get("content")
                    if isinstance(content, dict) and content.get("parts"):
                        delivered = True
                        owner.delta_chars += len(json.dumps(content["parts"], ensure_ascii=False))
            feedback = response.get("promptFeedback")
            blocked = isinstance(feedback, dict) and bool(feedback.get("blockReason"))
            if blocked or (len(finished) >= expected_candidates and seen.issubset(finished)):
                holder.terminal_kind = "completed"
            # This is the outermost body: charge only content handed to the
            # ASGI transport, never an event merely prefetched by Google I/O.
            owner.content_delivered |= delivered
            yield (
                f"data: {json.dumps(response, ensure_ascii=False)}\n\n"
                if owner.source.kind == "gemini_antigravity"
                else frame
            )
        if holder.terminal_kind != "completed":
            raise GoogleError(502, "Google stream ended without finishing every candidate")
        await owner.finish(status="success")
        if owner.settlement_failed:
            raise GoogleError(503, "Google usage settlement failed")
    except GoogleError as error:
        await owner.finish(status="error", error_code="google_stream_failed", error_message=str(error))
        yield f"data: {json.dumps(error.payload)}\n\n"
    except (aiohttp.ClientError, TimeoutError, UnicodeError):
        error = GoogleError(502, "Google stream transport failed after dispatch")
        await owner.finish(status="error", error_code="google_stream_failed", error_message=str(error))
        yield f"data: {json.dumps(error.payload)}\n\n"
    except BaseException:
        await owner.abandon("client_disconnected")
        raise


async def _dispatch(
    request: Request,
    api_key: ApiKeyData,
    *,
    kind: str,
    model: str,
    method: str,
    path: str,
    body: dict[str, JsonValue] | None,
) -> Response:
    streaming = method == "streamGenerateContent"
    allowed_models = set(api_key.allowed_models or [])
    if model and allowed_models and model not in allowed_models:
        raise GoogleError(403, "Model is outside this gateway key's allowlist")
    if api_key.enforced_reasoning_effort or api_key.enforced_service_tier or api_key.allowed_reasoning_efforts:
        raise GoogleError(
            400, "This key's OpenAI reasoning/service-tier policy cannot be applied to native Google requests"
        )
    if any(
        rule.limit_type == "credits" and (not rule.model_filter or rule.model_filter == model)
        for rule in api_key.limits
    ):
        raise GoogleError(400, "Codex credit limits cannot be applied to Google; use request, token or dollar limits")
    inner = body.get("request") if body else None
    raw_session = request.headers.get("x-gemini-lb-session") or (
        inner.get("session_id") if isinstance(inner, dict) else None
    )
    if raw_session is None and kind == "gemini_antigravity" and isinstance(inner, dict):
        # Native SDKs do not echo source headers. Keep appended tool/signature
        # turns on the first turn's account, scoped by gateway key and provider.
        contents = inner.get("contents")
        if isinstance(contents, list):
            first_user = next(
                (item for item in contents if isinstance(item, dict) and item.get("role", "user") == "user"), None
            )
            if first_user is not None:
                raw_session = (
                    "native:"
                    + hashlib.sha256(json.dumps(first_user, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                )
                inner["session_id"] = raw_session
    if raw_session is not None and (not isinstance(raw_session, str) or not 1 <= len(raw_session) <= 512):
        raise GoogleError(400, "Session ID must be a string of 1–512 characters")
    if kind == "gemini_antigravity" and isinstance(inner, dict) and raw_session is not None:
        inner["session_id"] = raw_session
    session_id = raw_session
    pin = request.headers.get("x-gemini-lb-account")
    existing = await lookup_session(api_key.id, kind, session_id) if session_id else None
    if pin and existing and pin != existing:
        raise GoogleError(409, "Explicit Google source conflicts with established session ownership")
    pin = pin or existing
    allowed_sources = allowed_source_ids_for_api_key(api_key)
    if pin and allowed_sources is not None and pin not in allowed_sources:
        raise GoogleError(403, "Pinned Google source is outside this gateway key's assignment scope")
    if body and _has_resource(body) and not pin:
        raise GoogleError(409, "Resource/signature references require an explicit source or established session")
    excluded: set[str] = set()
    last_error: GoogleError | None = None
    for _ in range(3):
        sources, cooldowns = await eligible_sources(kind, model, api_key, streaming=streaming)
        sources.sort(key=lambda source: get_source_bulkhead().in_flight(source.id))
        source, claims = None, None
        for candidate in sources:
            if candidate.id in excluded or candidate.id in cooldowns or (pin and candidate.id != pin):
                continue
            claims = try_claim(candidate)
            if claims is not None:
                source = candidate
                break
        if source is None or claims is None:
            if last_error is not None:
                raise last_error
            retry = min((until - utcnow()).total_seconds() for until in cooldowns.values()) if cooldowns else 1
            raise GoogleError(
                503,
                "No eligible Google source; check assignments, enabled models, quota and concurrency",
                retry_after=retry,
            )
        try:
            if session_id:
                winner = await claim_session(api_key.id, kind, session_id, source.id)
                if winner != source.id:
                    claims.release()
                    pin = winner
                    continue
                pin = winner
            generation = body.get("request", body) if body else {}
            config = generation.get("generationConfig", {}) if isinstance(generation, dict) else {}
            output = config.get("maxOutputTokens") if isinstance(config, dict) else None
            billable = method in {"generateContent", "streamGenerateContent", "embedContent", "batchEmbedContents"}
            budget = ApiKeyRequestUsageBudget(
                input_tokens=max(1, len(json.dumps(body or {}, ensure_ascii=False).encode()) // 4) if billable else 0,
                output_tokens=(
                    output if type(output) is int and output > 0 else API_KEY_USAGE_RESERVATION_DEFAULT_OUTPUT_TOKENS
                )
                if billable
                else 0,
            )
            async with get_background_session() as session:
                reservation = await ApiKeysService(ApiKeysRepository(session)).enforce_limits_for_request(
                    api_key.id, request_model=model, request_usage_budget=budget
                )
            owner = SourceDispatch(
                request=request,
                source=source,
                model=model,
                api_key=api_key,
                reservation=reservation,
                claims=claims,
                admission_budget=budget,
                requested_service_tier=None,
                settle_reservation=_settle,
                release_reservation=_release,
                upstream_transport="code_assist_http" if kind == "gemini_code_assist" else "gemini_http",
                bill_delivered_errors=True,
            )
            claims.transfer_to(owner)
        except BaseException:
            claims.release_if_unowned()
            raise
        try:
            if streaming:
                if body is None:
                    raise GoogleError(400, "Streaming requires a request object")
                credential = await open_with_disconnect_watch(request, owner, _open_stream(owner, path, body))
                count = config.get("candidateCount", 1) if isinstance(config, dict) else 1
                expected = count if type(count) is int and count > 0 else 1
                return SourceStreamingResponse(
                    _stream_body(owner, credential, expected),
                    owner=owner,
                    headers={
                        "Cache-Control": "no-cache, no-transform",
                        "X-Accel-Buffering": "no",
                        "x-gemini-lb-account": source.id,
                    },
                )
            result: dict[str, JsonValue] = await open_with_disconnect_watch(
                request, owner, google_json(source, path, body)
            )
            if method == "retrieveUserQuota":
                await save_quota(source.id, result)
            if kind == "gemini_antigravity":
                if method == "models":
                    result = {
                        "models": [
                            {
                                **{
                                    key: value
                                    for key, value in metadata.items()
                                    if key
                                    in {
                                        "displayName",
                                        "inputTokenLimit",
                                        "outputTokenLimit",
                                        "supportedGenerationMethods",
                                    }
                                },
                                "name": "models/" + name,
                            }
                            for name, metadata in antigravity.catalog_models(result).items()
                        ]
                    }
                else:
                    result = _body_response(result)
            catalog = result.get("models")
            if method == "models" and isinstance(catalog, list):
                source_models = {entry.model for entry in source.models if entry.is_enabled}
                result["models"] = [
                    entry
                    for entry in catalog
                    if isinstance(entry, dict)
                    and isinstance((name := entry.get("name")), str)
                    and (not allowed_models or name.removeprefix("models/") in allowed_models)
                    and name.removeprefix("models/") in source_models
                ]
            usage = _usage(result) if billable else SourceUsage(0, 0)
            owner.content_delivered = True
            await owner.finish(status="success", usage=usage, upstream_status_code=200)
            if owner.settlement_failed:
                raise GoogleError(503, "Google usage settlement failed")
            return JSONResponse(result, headers={"x-gemini-lb-account": source.id})
        except GoogleError as error:
            await owner.finish(
                status="error",
                error_code="google_upstream_failed",
                error_message=str(error),
                upstream_status_code=error.code,
            )
            last_error = error
            excluded.add(source.id)
            if error.retryable and not owner.content_delivered:
                await set_cooldown(source_credential(source).scope_hash(kind), model, error.retry_after or 2)
            if pin or not error.retryable or owner.content_delivered:
                raise
        except ClientDisconnectedDuringOpen:
            await owner.abandon("client_disconnected_during_open")
            return Response(status_code=499)
        except BaseException:
            await owner.abandon("dispatch_interrupted")
            raise
    raise last_error or GoogleError(503, "Google source retry limit reached")


async def native_google(request: Request) -> Response:
    try:
        api_key = await authenticate_google(request)
        personal = request.url.path.startswith("/antigravity/")
        native_path = request.url.path.removeprefix("/antigravity" if personal else "/gemini").rstrip("/")
        native = re.fullmatch(r"/(v1beta|v1)/models(?:/([a-zA-Z0-9._-]{1,128})(?::([a-zA-Z]+))?)?", native_path)
        assist = re.fullmatch(r"/v1internal:([a-zA-Z]+)", native_path)
        body: dict[str, JsonValue] | None = None
        if request.method == "POST":
            try:
                value = await request.json()
            except (ValueError, RecursionError):
                raise GoogleError(400, "Expected a JSON object") from None
            if not isinstance(value, dict):
                raise GoogleError(400, "Expected a JSON object")
            body = value
            controls = [body]
            if isinstance((inner_control := body.get("request")), dict):
                controls.append(inner_control)
            if any(item.get(name) for item in controls for name in ("enabledCreditTypes", "enabled_credit_types")):
                raise GoogleError(400, "Paid-credit opt-in is unsupported")
        if native:
            version, model, method = native.groups()
            model, method = model or "", method or "models"
            if (method == "models" and request.method != "GET") or (
                method != "models" and (request.method != "POST" or method not in _NATIVE_METHODS)
            ):
                raise GoogleError(501, "Unsupported Gemini model method")
            kind = "gemini_antigravity" if personal else "gemini_api_key"
            if model and api_key.enforced_model:
                model = api_key.enforced_model.removeprefix("models/")
            path = f"/{version}/models" + (f"/{model}" if model else "") + (f":{method}" if method != "models" else "")
        elif not personal and assist and request.method == "POST" and body is not None:
            method, kind = assist[1], "gemini_code_assist"
            if method not in _ASSIST_METHODS:
                raise GoogleError(501, "Unsupported Code Assist RPC; onboard with the official Gemini CLI first")
            inner = body.get("request")
            value = body.get("model", inner.get("model") if isinstance(inner, dict) else "")
            if not isinstance(value, str):
                raise GoogleError(400, "Invalid Google model")
            model = (api_key.enforced_model or value).removeprefix("models/")
            if method in {"generateContent", "streamGenerateContent", "countTokens"} and not model:
                raise GoogleError(400, "Google model is required")
            if body.get("enabled_credit_types"):
                raise GoogleError(400, "Paid-credit opt-in is unsupported")
            if method == "recordCodeAssistMetrics":
                return Response(status_code=204)
            path = native_path
        else:
            raise GoogleError(501, "Unsupported Google route; resource lifecycle APIs are not implemented")
        if model and not _MODEL.fullmatch(model):
            raise GoogleError(400, "Invalid Google model")
        if body and model:
            targets = [body]
            targets.extend(
                item for name in ("request", "generateContentRequest") if isinstance((item := body.get(name)), dict)
            )
            requests = body.get("requests")
            if isinstance(requests, list):
                targets.extend(item for item in requests if isinstance(item, dict))
            for target in targets:
                embedded = target.get("model")
                if embedded is not None:
                    if not isinstance(embedded, str) or (
                        not api_key.enforced_model and embedded.removeprefix("models/") != model
                    ):
                        raise GoogleError(400, "Embedded model conflicts with the routed Google model")
                    if api_key.enforced_model:
                        target["model"] = f"models/{model}" if embedded.startswith("models/") else model
        query = {}
        if method == "streamGenerateContent":
            if request.query_params.get("alt") != "sse":
                raise GoogleError(400, "Google streaming requires alt=sse")
            query["alt"] = "sse"
        elif method == "models":
            query = {
                name: request.query_params[name] for name in ("pageSize", "pageToken") if name in request.query_params
            }
        if personal:
            if method not in {"models", "generateContent", "streamGenerateContent", "countTokens"}:
                raise GoogleError(501, "Antigravity does not support this Gemini method")
            if method == "models":
                if query:
                    raise GoogleError(400, "Antigravity catalog pagination is unsupported")
                path, body = "/v1internal:fetchAvailableModels", {}
            else:
                path = f"/v1internal:{method}"
                if method == "countTokens":
                    counted = body.get("generateContentRequest", body) if body else {}
                    if not isinstance(counted, dict):
                        raise GoogleError(400, "Expected a generateContentRequest object")
                    body = {"request": counted}
                else:
                    body = {
                        "model": model,
                        "request": body or {},
                        "userAgent": "antigravity",
                        "requestType": "agent",
                        "requestId": f"agent-{uuid4()}",
                    }
        if query:
            path += "?" + urlencode(query)
        return await _dispatch(request, api_key, kind=kind, model=model, method=method, path=path, body=body)
    except GoogleError as error:
        return error_response(error)
    except ApiKeyRateLimitExceededError as error:
        return error_response(
            GoogleError(
                429, "Gateway key usage limit reached", retry_after=max(1, (error.reset_at - utcnow()).total_seconds())
            )
        )
    except ApiKeyInvalidError:
        return error_response(GoogleError(401, "Gateway key is invalid, disabled or expired"))
    except AppError as error:
        return error_response(GoogleError(error.status_code, error.message))


for prefix in ("", "/gemini", "/antigravity"):
    for version in ("v1beta", "v1"):
        for suffix in ("/models", "/models/{resource:path}"):
            path = f"{prefix}/{version}{suffix}"
            for method in ("GET", "POST"):
                router.add_api_route(path, native_google, methods=[method], response_model=None)
            router.add_api_route(
                path + "/", native_google, methods=["GET", "POST"], response_model=None, include_in_schema=False
            )
    if prefix == "/antigravity":
        continue
    router.add_api_route(f"{prefix}/v1internal:{{method}}", native_google, methods=["POST"], response_model=None)
    router.add_api_route(
        f"{prefix}/v1internal:{{method}}/",
        native_google,
        methods=["POST"],
        response_model=None,
        include_in_schema=False,
    )

for path in (
    "/v1beta/{resource:path}",
    "/gemini/v1beta/{resource:path}",
    "/gemini/v1/{resource:path}",
    "/antigravity/v1beta/{resource:path}",
    "/antigravity/v1/{resource:path}",
):
    router.add_api_route(
        path,
        native_google,
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        response_model=None,
        include_in_schema=False,
    )


@router.get("/healthz", include_in_schema=False)
async def legacy_health() -> dict[str, str]:
    from app import __version__

    return {"status": "ok", "version": __version__}
