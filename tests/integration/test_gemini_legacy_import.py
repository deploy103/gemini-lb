from __future__ import annotations

import base64
import hashlib
import json
import os
import sqlite3
import subprocess
import sys

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.crypto import TokenEncryptor
from app.db import models
from app.db.models import ApiKey, GeminiCooldown, GeminiSession, ModelSource, RequestLog
from app.modules.api_keys.repository import ApiKeysRepository
from app.modules.api_keys.service import ApiKeyInvalidError, ApiKeysService
from app.modules.gemini.legacy import LegacyImportError, import_legacy

pytestmark = pytest.mark.integration


def legacy_store(tmp_path):
    source = tmp_path / "legacy"
    source.mkdir()
    master = os.urandom(32)
    (source / "secrets.json").write_text(json.dumps({"version": 1, "master": base64.b64encode(master).decode()}))
    with sqlite3.connect(source / "gateway.db") as db:
        db.executescript("""
            CREATE TABLE accounts(id TEXT PRIMARY KEY,data TEXT,credential TEXT);
            CREATE TABLE client_keys(id TEXT PRIMARY KEY,key_hash TEXT,data TEXT);
            CREATE TABLE sessions(id TEXT PRIMARY KEY,account_id TEXT,expires INTEGER);
            CREATE TABLE cooldowns(scope TEXT,model TEXT,until INTEGER);
            CREATE TABLE requests(id TEXT PRIMARY KEY,created INTEGER,data TEXT);
            PRAGMA user_version=1;
        """)
        for sid, kind, credential, enabled, state in (
            ("api-one", "api-key", {"api_key": "secret-one"}, True, "ready"),
            ("api-two", "api-key", {"api_key": "secret-two"}, False, "ready"),
            (
                "oauth",
                "oauth",
                {"refresh_token": "refresh-secret", "client_id": "client", "client_secret": "registration"},
                True,
                "reauth_required",
            ),
        ):
            data = dict(
                id=sid,
                name=sid,
                kind=kind,
                project="project",
                quotaScope=f"scope:{sid}",
                models=["gemini-2.5-flash"],
                maxInflight=3,
                enabled=enabled,
                state=state,
                createdAt=1700000000123,
                quota={"buckets": [{"modelId": "gemini-2.5-flash", "remainingFraction": 0.25}]}
                if sid == "oauth"
                else None,
                quotaUpdatedAt=1700000000456 if sid == "oauth" else None,
            )
            nonce = os.urandom(12)
            encrypted = AESGCM(master).encrypt(nonce, json.dumps(credential).encode(), sid.encode())
            envelope = nonce + encrypted[-16:] + encrypted[:-16]
            db.execute(
                "INSERT INTO accounts VALUES(?,?,?)", (sid, json.dumps(data), base64.b64encode(envelope).decode())
            )
        for kid, enabled, allowed in (("client", True, ["api-one"]), ("revoked", False, [])):
            db.execute(
                "INSERT INTO client_keys VALUES(?,?,?)",
                (
                    kid,
                    hashlib.sha256(f"glb-{kid}".encode()).hexdigest(),
                    json.dumps(dict(id=kid, name=kid, enabled=enabled, accounts=allowed, createdAt=1700000000123)),
                ),
            )
        digest = hashlib.sha256(b"client\0session").hexdigest()
        db.execute("INSERT INTO sessions VALUES(?,?,?)", (digest, "api-one", 4102444800000))
        db.execute("INSERT INTO cooldowns VALUES(?,?,?)", ("scope:api-one", "*", 4102444800000))
        db.execute(
            "INSERT INTO requests VALUES(?,?,?)",
            (
                "request-one",
                1700000000123,
                json.dumps(
                    dict(
                        accountId="api-one",
                        model="gemini-2.5-flash",
                        status=200,
                        outcome="success",
                        durationMs=37,
                        tokens=23,
                        prompt="NEVER COPY",
                        error="NEVER COPY",
                    )
                ),
            ),
        )
    return source


def checksums(source):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir() if p.is_file()}


async def test_import_preserves_identity_and_reencrypts(tmp_path):
    source = legacy_store(tmp_path)
    before = checksums(source)
    target = tmp_path / "new"
    counts = await import_legacy(source, target, stopped=True, dry_run=True)
    assert counts["accounts"] == 3 and not target.exists()
    assert counts["quota_snapshots"] == 1
    assert await import_legacy(source, target, stopped=True) == counts
    assert checksums(source) == before
    encryptor = TokenEncryptor(key_file=target / "encryption.key")
    engine = create_async_engine(f"sqlite+aiosqlite:///{target / 'store.db'}")
    try:
        async with async_sessionmaker(engine)() as session:
            sources = {s.id: s for s in (await session.scalars(select(ModelSource))).all()}
            api_credential = sources["api-one"].api_key_encrypted
            oauth_credential = sources["oauth"].api_key_encrypted
            assert api_credential is not None and oauth_credential is not None
            assert json.loads(encryptor.decrypt(api_credential))["api_key"] == "secret-one"
            oauth = json.loads(encryptor.decrypt(oauth_credential))
            assert oauth["project"] == "project" and oauth["quota_scope"] == "scope:oauth"
            quota = await session.get(models.GeminiQuota, "oauth")
            assert quota is not None and json.loads(quota.snapshot_json)["buckets"][0]["remainingFraction"] == 0.25
            assert not sources["api-two"].is_enabled and sources["oauth"].health_status == "reauth_required"
            assert sources["api-one"].max_concurrency == 3
            assert [m.model for m in sources["api-one"].models] == ["gemini-2.5-flash"]
            key = await session.get(ApiKey, "client")
            assert key is not None
            assert key.source_assignment_scope_enabled and [a.source_id for a in key.source_assignments] == ["api-one"]
            service = ApiKeysService(ApiKeysRepository(session))
            assert (await service.validate_key("glb-client")).id == "client"
            with pytest.raises(ApiKeyInvalidError):
                await service.validate_key("glb-revoked")
            binding = await session.get(GeminiSession, hashlib.sha256(b"client\0session").hexdigest())
            assert binding is not None and binding.source_id == "api-one"
            cooldown = await session.get(
                GeminiCooldown, (hashlib.sha256(b"gemini_api_key\0scope:api-one").hexdigest(), "")
            )
            assert cooldown is not None and cooldown.expires_at.year == 2100
            log = await session.scalar(select(RequestLog))
            assert log is not None
            assert log.model_source_id == "api-one" and log.input_tokens is None and log.output_tokens is None
            assert log.error_message is None and log.latency_ms == 37
    finally:
        await engine.dispose()


@pytest.mark.parametrize("failure", ["credential", "aad", "scope", "nonempty", "lock", "ack"])
async def test_import_rejection_is_atomic(tmp_path, failure):
    source = legacy_store(tmp_path)
    target = tmp_path / "target"
    if failure == "credential":
        with sqlite3.connect(source / "gateway.db") as db:
            db.execute("UPDATE accounts SET credential='invalid'")
    elif failure == "aad":
        with sqlite3.connect(source / "gateway.db") as db:
            db.execute(
                "UPDATE accounts SET credential=(SELECT credential FROM accounts WHERE id='api-two') WHERE id='api-one'"
            )
    elif failure == "scope":
        with sqlite3.connect(source / "gateway.db") as db:
            data = json.loads(db.execute("SELECT data FROM client_keys WHERE id='client'").fetchone()[0])
            data["accounts"] = ["missing"]
            db.execute("UPDATE client_keys SET data=? WHERE id='client'", (json.dumps(data),))
    elif failure == "nonempty":
        target.mkdir()
        (target / "keep").write_bytes(b"unchanged")
    elif failure == "lock":
        (source / "instance.lock").mkdir()
    before = checksums(source)
    with pytest.raises(LegacyImportError):
        await import_legacy(source, target, stopped=failure != "ack")
    assert checksums(source) == before
    if failure == "nonempty":
        assert (target / "keep").read_bytes() == b"unchanged" and len(list(target.iterdir())) == 1
    else:
        assert not target.exists()


def test_cli_dry_run_is_offline_and_secret_free(tmp_path):
    source = legacy_store(tmp_path)
    before = checksums(source)
    target = tmp_path / "target"
    result = subprocess.run(
        [sys.executable, "-m", "scripts.import_legacy_gemini", str(source), str(target), "--stopped", "--dry-run"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["accounts"] == 3
    assert "secret" not in result.stdout + result.stderr
    assert checksums(source) == before and not target.exists()
