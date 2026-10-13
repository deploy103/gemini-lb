from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.core.crypto import TokenEncryptor
from app.core.types import JsonValue
from app.core.utils.time import utcnow
from app.db.models import GeminiCooldown, GeminiQuota, GeminiSession, ModelSource, RequestLog
from app.db.session import detach_session_objects, get_background_session, sqlite_writer_section
from app.modules.api_keys.service import ApiKeyData
from app.modules.gemini.credentials import parse_google_credential
from app.modules.model_sources.repository import ModelSourcesRepository
from app.modules.model_sources.selection import allowed_source_ids_for_api_key


def session_hash(key_id: str, kind: str, session_id: str) -> str:
    return hashlib.sha256(f"{key_id}\0{kind}\0{session_id}".encode()).hexdigest()


async def lookup_session(key_id: str, kind: str, session_id: str) -> str | None:
    async with get_background_session() as session:
        owner = await session.scalar(
            select(GeminiSession.source_id).where(
                GeminiSession.session_hash == session_hash(key_id, kind, session_id),
                GeminiSession.expires_at > utcnow(),
            )
        )
        if owner is not None:
            return owner
        legacy_hash = hashlib.sha256(f"{key_id}\0{session_id}".encode()).hexdigest()
        owner = await session.scalar(
            select(GeminiSession.source_id).where(
                GeminiSession.session_hash == legacy_hash,
                GeminiSession.expires_at > utcnow(),
            )
        )
        if owner is not None:
            provider = await session.scalar(select(ModelSource.kind).where(ModelSource.id == owner))
            # A deleted legacy owner still refuses dispatch instead of moving
            # its resources. Existing owners are isolated by provider kind.
            if provider is None or provider == kind:
                return owner
        return None


async def claim_session(key_id: str, kind: str, session_id: str, source_id: str) -> str:
    async with get_background_session() as session, sqlite_writer_section():
        now = utcnow()
        await session.execute(delete(GeminiSession).where(GeminiSession.expires_at <= now))
        insert = sqlite_insert if session.get_bind().dialect.name == "sqlite" else pg_insert
        digest = session_hash(key_id, kind, session_id)
        stmt = insert(GeminiSession).values(
            session_hash=digest, source_id=source_id, expires_at=now + timedelta(hours=24)
        )
        # A loser in an ownership race reads the winner; it never overwrites
        # the winner's source. Existing ownership only slides its own TTL.
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=[GeminiSession.session_hash],
                set_={"expires_at": stmt.excluded.expires_at},
                where=GeminiSession.source_id == source_id,
            )
        )
        owner = await session.scalar(select(GeminiSession.source_id).where(GeminiSession.session_hash == digest))
        await session.commit()
        if owner is None:
            raise RuntimeError("Google session claim did not persist")
        return owner


async def eligible_sources(
    kind: str, model: str, api_key: ApiKeyData, *, streaming: bool
) -> tuple[list[ModelSource], dict[str, datetime]]:
    allowed = allowed_source_ids_for_api_key(api_key)
    async with get_background_session() as session:
        sources = await ModelSourcesRepository(session).list_enabled_sources()
        sources = [
            source
            for source in sources
            if source.kind == kind
            and source.health_status != "reauth_required"
            and (allowed is None or source.id in allowed)
            and any(
                entry.is_enabled and (not model or entry.model == model) and (not streaming or entry.supports_streaming)
                for entry in source.models
            )
        ]
        last_used = {
            source_id: requested_at
            for source_id, requested_at in (
                await session.execute(
                    select(RequestLog.model_source_id, func.max(RequestLog.requested_at))
                    .where(RequestLog.model_source_id.in_([source.id for source in sources]))
                    .group_by(RequestLog.model_source_id)
                )
            ).all()
        }
        sources.sort(key=lambda source: (last_used.get(source.id) or datetime.min, source.id))
        encryptor = TokenEncryptor()
        hashes = {
            source.id: parse_google_credential(
                source.kind, encryptor.decrypt(source.api_key_encrypted) if source.api_key_encrypted else None
            ).scope_hash(source.kind)
            for source in sources
        }
        cooldowns = (
            await session.execute(
                select(GeminiCooldown.quota_hash, func.max(GeminiCooldown.expires_at))
                .where(
                    GeminiCooldown.quota_hash.in_(hashes.values()),
                    GeminiCooldown.model.in_([model, ""]),
                    GeminiCooldown.expires_at > utcnow(),
                )
                .group_by(GeminiCooldown.quota_hash)
            )
        ).all()
        by_hash = {digest: expires_at for digest, expires_at in cooldowns}
        by_source = {source_id: by_hash[digest] for source_id, digest in hashes.items() if digest in by_hash}
        snapshots = (
            await session.scalars(
                select(GeminiQuota).where(GeminiQuota.source_id.in_([source.id for source in sources]))
            )
        ).all()
        for snapshot in snapshots:
            until = exhausted_quota_until(json.loads(snapshot.snapshot_json), model)
            if until is not None:
                by_source[snapshot.source_id] = max(until, by_source.get(snapshot.source_id, datetime.min))
        detach_session_objects(session)
        return sources, by_source


def exhausted_quota_until(snapshot: dict[str, JsonValue], model: str) -> datetime | None:
    buckets = snapshot.get("buckets")
    if not model or not isinstance(buckets, list):
        return None
    now, blocked = utcnow(), []
    for bucket in buckets:
        if not isinstance(bucket, dict) or bucket.get("modelId") not in {None, model, f"models/{model}"}:
            continue
        remaining = bucket.get("remainingFraction")
        if not (
            (isinstance(remaining, (int, float)) and not isinstance(remaining, bool) and remaining == 0)
            or bucket.get("remainingAmount") == "0"
        ):
            continue
        reset = bucket.get("resetTime")
        until = now + timedelta(days=365)
        if isinstance(reset, str):
            try:
                until = datetime.fromisoformat(reset).astimezone(UTC).replace(tzinfo=None)
            except ValueError:
                pass
        if until > now:
            blocked.append(until)
    return max(blocked) if blocked else None


async def save_quota(source_id: str, snapshot: dict[str, JsonValue]) -> None:
    async with get_background_session() as session, sqlite_writer_section():
        insert = sqlite_insert if session.get_bind().dialect.name == "sqlite" else pg_insert
        stmt = insert(GeminiQuota).values(
            source_id=source_id,
            snapshot_json=json.dumps(snapshot),
            updated_at=utcnow(),
        )
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=[GeminiQuota.source_id],
                set_={
                    "snapshot_json": stmt.excluded.snapshot_json,
                    "updated_at": stmt.excluded.updated_at,
                },
            )
        )
        await session.commit()


async def set_cooldown(quota_hash: str, model: str, seconds: float) -> None:
    async with get_background_session() as session, sqlite_writer_section():
        now = utcnow()
        await session.execute(delete(GeminiCooldown).where(GeminiCooldown.expires_at <= now))
        insert = sqlite_insert if session.get_bind().dialect.name == "sqlite" else pg_insert
        stmt = insert(GeminiCooldown).values(
            quota_hash=quota_hash, model=model, expires_at=now + timedelta(seconds=seconds)
        )
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=[GeminiCooldown.quota_hash, GeminiCooldown.model],
                set_={"expires_at": stmt.excluded.expires_at},
                where=GeminiCooldown.expires_at < stmt.excluded.expires_at,
            )
        )
        await session.commit()
