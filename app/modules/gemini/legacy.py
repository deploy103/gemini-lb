"""Bounded, read-only import of the stopped 0.1 SQLite store.

The destination is built privately and published only after a successful commit.
Legacy admin authentication is deliberately not imported.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.crypto import TokenEncryptor
from app.db import models
from app.db.migrate import run_startup_migrations
from app.modules.gemini.credentials import normalized_google_credential

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ROWS = 100_000


class LegacyImportError(ValueError):
    """Safe operator-facing error; never contains credential or JSON input."""


def _date(value: object) -> datetime:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise LegacyImportError("Invalid legacy timestamp")
    return datetime.fromtimestamp(value / 1000, timezone.utc).replace(tzinfo=None)


def _object(value: str) -> dict:
    result = json.loads(value)
    if not isinstance(result, dict):
        raise LegacyImportError("Invalid legacy metadata")
    return result


def _target_empty(target: Path) -> None:
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise LegacyImportError("Target must be a new or empty directory; stop both instances")


def _read(source: Path) -> dict[str, list[dict]]:
    if (source / "instance.lock").exists():
        raise LegacyImportError("Source instance.lock exists; stop source and inspect the lock")
    for name in ("secrets.json", "gateway.db", "gateway.db-wal", "gateway.db-shm"):
        path = source / name
        if path.exists() and (not path.is_file() or path.stat().st_size > MAX_FILE_BYTES):
            raise LegacyImportError("Legacy store exceeds import size limit")
    # A stopped, checkpointed database needs no sidecar writes. Refuse WAL
    # rather than ignoring committed transactions or touching source bytes.
    if (source / "gateway.db-wal").exists() and (source / "gateway.db-wal").stat().st_size:
        raise LegacyImportError("Checkpoint and close the legacy database before importing")
    try:
        secrets = _object((source / "secrets.json").read_text())
        master = base64.b64decode(secrets["master"], validate=True)
        if secrets["version"] != 1 or len(master) != 32:
            raise LegacyImportError("Unsupported legacy secrets")
        result = {}
        with sqlite3.connect(f"{(source / 'gateway.db').as_uri()}?mode=ro&immutable=1", uri=True) as db:
            db.row_factory = sqlite3.Row
            if db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
                raise LegacyImportError("Unsupported legacy database version")
            for table in ("accounts", "client_keys", "sessions", "cooldowns", "requests"):
                rows = db.execute(f'SELECT * FROM "{table}" LIMIT ?', (MAX_ROWS + 1,)).fetchall()
                if len(rows) > MAX_ROWS:
                    raise LegacyImportError("Legacy store exceeds row limit")
                result[table] = [dict(row) for row in rows]
        for row in result["accounts"]:
            data = _object(row["data"])
            if data.get("id") != row["id"] or data.get("kind") not in ("api-key", "oauth"):
                raise LegacyImportError("Invalid legacy account identity")
            kind = "gemini_api_key" if data["kind"] == "api-key" else "gemini_code_assist"
            encrypted = base64.b64decode(row["credential"], validate=True)
            credential = _object(
                AESGCM(master).decrypt(encrypted[:12], encrypted[28:] + encrypted[12:28], row["id"].encode()).decode()
            )
            credential.update(project=data["project"], quota_scope=data["quotaScope"])
            row.update(metadata=data, kind=kind, normalized=normalized_google_credential(kind, json.dumps(credential)))
            _date(data["createdAt"])
            if not isinstance(data["models"], list) or any(not isinstance(m, str) for m in data["models"]):
                raise LegacyImportError("Invalid legacy models")
            if data["state"] not in ("ready", "reauth_required") or type(data["enabled"]) is not bool:
                raise LegacyImportError("Invalid legacy account state")
            if type(data["maxInflight"]) is not int or not 1 <= data["maxInflight"] <= 64:
                raise LegacyImportError("Invalid legacy concurrency")
        ids = {row["id"] for row in result["accounts"]}
        for row in result["client_keys"]:
            data = _object(row["data"])
            allowed = data["accounts"]
            if not isinstance(allowed, list) or any(not isinstance(v, str) or v not in ids for v in allowed):
                raise LegacyImportError("Dangling legacy client source scope")
            if data.get("id") != row["id"] or type(data["enabled"]) is not bool:
                raise LegacyImportError("Invalid legacy client identity")
            if len(row["key_hash"]) != 64 or any(c not in "0123456789abcdef" for c in row["key_hash"]):
                raise LegacyImportError("Invalid legacy client digest")
            _date(data["createdAt"])
            row["metadata"] = data
        return result
    except LegacyImportError:
        raise
    except Exception:
        raise LegacyImportError("Invalid legacy store or credential; nothing imported") from None


async def import_legacy(source: Path, target: Path, *, stopped: bool = False, dry_run: bool = False) -> dict[str, int]:
    """Import into a NEW target, requiring an explicit offline acknowledgement."""
    if not stopped:
        raise LegacyImportError("Explicit acknowledgement that source and target are stopped is required")
    source, target = source.expanduser().resolve(), target.expanduser().resolve()
    if source == target or source in target.parents or target in source.parents:
        raise LegacyImportError("Source and target directories must be separate")
    _target_empty(target)
    rows = _read(source)
    counts = {name: len(items) for name, items in rows.items()}
    objects = []
    by_id = {r["id"]: r for r in rows["accounts"]}
    key_ids = {r["id"] for r in rows["client_keys"]}
    scope_kinds: dict[str, set[str]] = {}
    for row in rows["accounts"]:
        scope_kinds.setdefault(row["metadata"]["quotaScope"], set()).add(row["kind"])
    for row in rows["accounts"]:
        data = row["metadata"]
        objects.append(
            models.ModelSource(
                id=row["id"],
                name=data["name"],
                kind=row["kind"],
                base_url=(
                    "https://generativelanguage.googleapis.com"
                    if data["kind"] == "api-key"
                    else "https://cloudcode-pa.googleapis.com"
                ),
                is_enabled=data["enabled"],
                health_status="reauth_required" if data["state"] == "reauth_required" else "unknown",
                max_concurrency=data["maxInflight"],
                supports_chat_completions=False,
                created_at=_date(data["createdAt"]),
                models=[models.ModelSourceModel(model=m) for m in dict.fromkeys(data["models"])],
            )
        )
        if data.get("quota") is not None:
            objects.append(
                models.GeminiQuota(
                    source_id=row["id"],
                    snapshot_json=json.dumps(data["quota"]),
                    updated_at=_date(data["quotaUpdatedAt"] or data["createdAt"]),
                )
            )
    for row in rows["client_keys"]:
        data = row["metadata"]
        objects.append(
            models.ApiKey(
                id=row["id"],
                name=data["name"],
                key_hash=row["key_hash"],
                key_prefix="glb-",
                is_active=data["enabled"],
                source_assignment_scope_enabled=bool(data["accounts"]),
                created_at=_date(data["createdAt"]),
            )
        )
        objects.extend(
            models.ApiKeyModelSourceAssignment(api_key_id=row["id"], source_id=sid)
            for sid in dict.fromkeys(data["accounts"])
        )
    for row in rows["sessions"]:
        if len(row["id"]) != 64 or any(c not in "0123456789abcdef" for c in row["id"]):
            raise LegacyImportError("Invalid legacy session digest")
        # Keep deleted-source bindings too: a resource-bound session cannot move.
        objects.append(
            models.GeminiSession(session_hash=row["id"], source_id=row["account_id"], expires_at=_date(row["expires"]))
        )
    for row in rows["cooldowns"]:
        for kind in scope_kinds.get(row["scope"], set()):
            objects.append(
                models.GeminiCooldown(
                    quota_hash=hashlib.sha256(f"{kind}\0{row['scope']}".encode()).hexdigest(),
                    model="" if row["model"] == "*" else row["model"],
                    expires_at=_date(row["until"]),
                )
            )
    for row in rows["requests"]:
        data = _object(row["data"])
        source_row = by_id.get(data.get("accountId"))
        if data["outcome"] not in ("success", "failed", "partial", "cancelled"):
            raise LegacyImportError("Invalid legacy request outcome")
        objects.append(
            models.RequestLog(
                request_id=row["id"],
                requested_at=_date(row["created"]),
                model=data["model"],
                model_source_id=data.get("accountId"),
                model_source_kind=source_row["kind"] if source_row else None,
                api_key_id=data.get("keyId") if data.get("keyId") in key_ids else None,
                status=data["outcome"],
                upstream_status_code=data["status"],
                latency_ms=data["durationMs"],
            )
        )
    counts["quota_snapshots"] = sum(r["metadata"].get("quota") is not None for r in rows["accounts"])
    if dry_run:
        return counts
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".gemini-import-", dir=target.parent))
    engine = None
    try:
        url = f"sqlite+aiosqlite:///{staging / 'store.db'}"
        await run_startup_migrations(url)
        encryptor = TokenEncryptor(key_file=staging / "encryption.key")
        for obj in objects:
            if isinstance(obj, models.ModelSource):
                obj.api_key_encrypted = encryptor.encrypt(by_id[obj.id]["normalized"])
        engine = create_async_engine(url)
        async with async_sessionmaker(engine)() as session:
            async with session.begin():
                session.add_all(objects)
        await engine.dispose()
        engine = None
        (staging / "store.db").chmod(0o600)
        _target_empty(target)
        if target.exists():
            target.rmdir()
        staging.rename(target)
        return counts
    except LegacyImportError:
        raise
    except Exception:
        raise LegacyImportError("Target import failed; source is unchanged and no target was published") from None
    finally:
        if engine is not None:
            await engine.dispose()
        if staging.exists():
            shutil.rmtree(staging)
