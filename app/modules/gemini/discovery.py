from __future__ import annotations

import re
from urllib.parse import urlencode

from app.core.types import JsonValue
from app.db.models import ModelSource
from app.modules.gemini import antigravity
from app.modules.gemini.repository import save_quota
from app.modules.gemini.transport import GoogleError, google_json
from app.modules.model_sources.schemas import ModelSourceModelInput


async def discover_google_models(source: ModelSource) -> list[ModelSourceModelInput]:
    """Read provider metadata, never infer availability from a generated response."""
    if source.kind == "gemini_antigravity":
        result = await google_json(source, "/v1internal:fetchAvailableModels", {})
        models = antigravity.catalog_models(result)
        quota = antigravity.model_quota(result)
        discovered: list[ModelSourceModelInput] = []
        for model, metadata in sorted(models.items()):
            display = metadata.get("displayName")
            limits: list[int | None] = []
            for field in ("inputTokenLimit", "outputTokenLimit"):
                value = metadata.get(field)
                if value is not None and (type(value) is not int or value <= 0):
                    raise GoogleError(502, "Google returned invalid Antigravity token limits")
                limits.append(value if type(value) is int else None)
            discovered.append(
                ModelSourceModelInput(
                    model=model,
                    display_name=display[:255] if isinstance(display, str) else None,
                    context_window=limits[0],
                    max_output_tokens=limits[1],
                )
            )
        await save_quota(source.id, quota)
        return discovered
    if source.kind == "gemini_code_assist":
        await google_json(source, "/v1internal:loadCodeAssist", {"metadata": {}})
        quota = await google_json(source, "/v1internal:retrieveUserQuota", {})
        await save_quota(source.id, quota)
        buckets = quota["buckets"]
        ids: set[str] = set()
        if isinstance(buckets, list):
            for bucket in buckets:
                model = bucket.get("modelId") if isinstance(bucket, dict) else None
                if isinstance(model, str):
                    ids.add(model)
        return [
            ModelSourceModelInput(model=model) for model in sorted(ids) if re.fullmatch(r"[a-zA-Z0-9._-]{1,128}", model)
        ]

    models: dict[str, ModelSourceModelInput] = {}
    token = ""
    seen_tokens: set[str] = set()
    total = 0
    for _ in range(10):
        query = urlencode({"pageSize": 100, **({"pageToken": token} if token else {})})
        result = await google_json(source, f"/v1beta/models?{query}", None)
        rows = result.get("models", [])
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise GoogleError(502, "Google returned an invalid model catalog")
        total += len(rows)
        if total > 1000:
            raise GoogleError(502, "Google model catalog exceeds the discovery safety bound")
        for row in rows:
            if not isinstance(row, dict):
                continue
            name, methods = row.get("name"), row.get("supportedGenerationMethods")
            if not isinstance(name, str) or not re.fullmatch(r"models/[a-zA-Z0-9._-]{1,128}", name):
                raise GoogleError(502, "Google returned an invalid model identifier")
            if not isinstance(methods, list) or any(not isinstance(method, str) for method in methods):
                raise GoogleError(502, "Google returned invalid model capabilities")
            if not {"generateContent", "embedContent", "batchEmbedContents"}.intersection(methods):
                continue
            for field in ("inputTokenLimit", "outputTokenLimit"):
                value = row.get(field)
                if value is not None and (type(value) is not int or value <= 0):
                    raise GoogleError(502, "Google returned invalid model token limits")
            display_name = row.get("displayName")
            input_limit, output_limit = row.get("inputTokenLimit"), row.get("outputTokenLimit")
            models[name[7:]] = ModelSourceModelInput(
                model=name[7:],
                display_name=display_name[:255] if isinstance(display_name, str) else None,
                context_window=input_limit if isinstance(input_limit, int) else None,
                max_output_tokens=output_limit if isinstance(output_limit, int) else None,
                supports_streaming="generateContent" in methods,
            )
        next_token: JsonValue = result.get("nextPageToken", "")
        if not isinstance(next_token, str) or len(next_token) > 4096:
            raise GoogleError(502, "Google returned an invalid model page token")
        if not next_token:
            return sorted(models.values(), key=lambda model: model.model)
        if next_token in seen_tokens:
            raise GoogleError(502, "Google model pagination did not advance")
        seen_tokens.add(next_token)
        token = next_token
    raise GoogleError(502, "Google model catalog exceeds the discovery page limit")
