"""Antigravity wire identity and account-managed project parsing."""

# Protocol constants/project parsing adapted from CLIProxyAPI (MIT).
# See app/modules/gemini/CLIProxyAPI-MIT.txt for attribution and license.
import re

from app.core.types import JsonValue

BASE_URL = "https://daily-cloudcode-pa.googleapis.com"
VERSION = "2.9.1"
USER_AGENT = f"antigravity/hub/{VERSION} darwin/arm64"
ONBOARD_USER_AGENT = USER_AGENT + " google-api-nodejs-client/10.3.0"
REDIRECT_URI = "http://localhost:51121/oauth-callback"


def account_project(payload: dict[str, JsonValue]) -> str | None:
    for key in ("cloudaicompanionProject", "projectId", "project"):
        value = payload.get(key)
        if isinstance(value, dict):
            value = value.get("id")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def catalog_models(payload: dict[str, JsonValue]) -> dict[str, dict[str, JsonValue]]:
    from app.modules.gemini.transport import GoogleError

    models = payload.get("models")
    if not isinstance(models, dict) or len(models) > 1000:
        raise GoogleError(502, "Google returned an invalid Antigravity model catalog")
    parsed: dict[str, dict[str, JsonValue]] = {}
    for model, metadata in models.items():
        if not re.fullmatch(r"[a-zA-Z0-9._-]{1,128}", model) or not isinstance(metadata, dict):
            raise GoogleError(502, "Google returned invalid Antigravity model metadata")
        parsed[model] = metadata
    return parsed


def model_quota(payload: dict[str, JsonValue]) -> dict[str, JsonValue]:
    from app.modules.gemini.transport import GoogleError

    buckets: list[JsonValue] = []
    for model, metadata in catalog_models(payload).items():
        quota = metadata.get("quotaInfo")
        if quota is None:
            continue
        if not isinstance(quota, dict):
            raise GoogleError(502, "Google returned invalid Antigravity quota metadata")
        bucket: dict[str, JsonValue] = {"modelId": model}
        fraction = quota.get("remainingFraction")
        if fraction is not None:
            if not isinstance(fraction, (int, float)) or isinstance(fraction, bool) or not 0 <= fraction <= 1:
                raise GoogleError(502, "Google returned an invalid quota fraction")
            bucket["remainingFraction"] = fraction
        reset = quota.get("resetTime")
        if reset is not None:
            if not isinstance(reset, str):
                raise GoogleError(502, "Google returned an invalid quota reset")
            bucket["resetTime"] = reset
        if len(bucket) > 1:
            buckets.append(bucket)
    return {"buckets": buckets}
