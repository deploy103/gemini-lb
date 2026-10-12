from __future__ import annotations

import hashlib
import json
import time
from typing import Literal

from pydantic import BaseModel, Field, model_validator

GeminiSourceKind = Literal["gemini_api_key", "gemini_code_assist"]
GEMINI_SOURCE_KINDS = frozenset({"gemini_api_key", "gemini_code_assist"})


class GoogleCredential(BaseModel):
    api_key: str | None = Field(default=None, min_length=1, repr=False)
    access_token: str | None = Field(default=None, min_length=1, repr=False)
    refresh_token: str | None = Field(default=None, min_length=1, repr=False)
    client_id: str | None = Field(default=None, min_length=1)
    client_secret: str | None = Field(default=None, min_length=1, repr=False)
    expiry_date: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    project: str | None = Field(default=None, min_length=1, max_length=256)
    quota_scope: str | None = Field(default=None, min_length=1, max_length=256)

    @model_validator(mode="after")
    def validate_identity(self) -> GoogleCredential:
        if self.api_key:
            if self.access_token or self.refresh_token:
                raise ValueError("API-key and OAuth credentials must be separate sources")
            return self
        if not self.project:
            raise ValueError("Code Assist requires an already onboarded Google project")
        if self.refresh_token:
            if not self.client_id or not self.client_secret:
                raise ValueError("OAuth refresh requires the matching client_id and client_secret")
        elif not self.access_token or not self.expiry_date:
            raise ValueError("OAuth requires refresh credentials or an access token with expiry_date")
        return self

    def scope_hash(self, kind: str) -> str:
        # Google API-key quota is not necessarily per key. Operators can group
        # keys from one Google quota project explicitly without storing secrets
        # in the cooldown table. OAuth defaults to the imported user identity.
        identity = self.quota_scope or self.api_key or self.refresh_token or self.access_token or ""
        return hashlib.sha256(f"{kind}\0{identity}".encode()).hexdigest()


def parse_google_credential(kind: str, value: str | None) -> GoogleCredential:
    if not value:
        raise ValueError("Google credentials are required")
    try:
        credential = (
            GoogleCredential(api_key=value)
            if kind == "gemini_api_key" and not value.lstrip().startswith("{")
            else GoogleCredential.model_validate_json(value)
        )
        if (kind == "gemini_api_key") != bool(credential.api_key):
            raise ValueError("Credential does not match the selected Google provider")
        return credential
    except ValueError:
        # Pydantic errors include input values; never reflect credential input.
        raise ValueError(
            "Invalid Google credential: API key, or OAuth JSON with project, expiry_date "
            "and access_token; refresh requires refresh_token, client_id and client_secret"
        ) from None


def normalized_google_credential(kind: str, value: str | None) -> str:
    credential = parse_google_credential(kind, value)
    if not credential.api_key and not credential.refresh_token and (credential.expiry_date or 0) <= time.time() * 1000:
        raise ValueError("OAuth import requires refresh credentials or an unexpired access token")
    if not credential.quota_scope:
        # Keep quota identity stable even when the provider rotates tokens.
        credential.quota_scope = credential.scope_hash(kind)
    return json.dumps(credential.model_dump(exclude_none=True), separators=(",", ":"))
