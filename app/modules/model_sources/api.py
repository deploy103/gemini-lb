from __future__ import annotations

import json

from fastapi import APIRouter, Body, Depends, Request, Response

from app.core.audit.service import AuditActor, AuditService, AuditTarget
from app.core.auth.dashboard_access import DashboardPrincipal
from app.core.auth.dependencies import (
    require_dashboard_write_access,
    set_dashboard_error_format,
    validate_dashboard_session,
)
from app.core.exceptions import DashboardBadRequestError, DashboardNotFoundError
from app.core.utils.time import utcnow
from app.db.models import GeminiQuota
from app.dependencies import ModelSourcesContext, get_model_sources_context
from app.modules.gemini.repository import save_quota
from app.modules.gemini.transport import GoogleError, google_json
from app.modules.model_sources.schemas import (
    ModelSourceCreateRequest,
    ModelSourceQuotaResponse,
    ModelSourceResponse,
    ModelSourcesResponse,
    ModelSourceUpdateRequest,
)
from app.modules.model_sources.service import ModelSourceNotFoundError, ModelSourceValidationError

router = APIRouter(
    prefix="/api/model-sources",
    tags=["dashboard"],
    dependencies=[Depends(validate_dashboard_session), Depends(set_dashboard_error_format)],
)


@router.get("/", response_model=ModelSourcesResponse)
async def list_model_sources(
    context: ModelSourcesContext = Depends(get_model_sources_context),
) -> ModelSourcesResponse:
    return ModelSourcesResponse(sources=await context.service.list_sources())


@router.post("/", response_model=ModelSourceResponse)
async def create_model_source(
    request: Request,
    payload: ModelSourceCreateRequest = Body(...),
    principal: DashboardPrincipal = Depends(require_dashboard_write_access),
    context: ModelSourcesContext = Depends(get_model_sources_context),
) -> ModelSourceResponse:
    try:
        created = await context.service.create_source(payload)
    except ModelSourceValidationError as exc:
        raise DashboardBadRequestError(str(exc), code="invalid_model_source_payload") from exc
    AuditService.log_async(
        "model_source_created",
        actor_ip=request.client.host if request.client else None,
        actor=AuditActor.from_principal(principal),
        target=AuditTarget("model_source", created.id),
        details={"source_id": created.id},
    )
    return created


@router.patch("/{source_id}", response_model=ModelSourceResponse)
async def update_model_source(
    request: Request,
    source_id: str,
    payload: ModelSourceUpdateRequest = Body(...),
    principal: DashboardPrincipal = Depends(require_dashboard_write_access),
    context: ModelSourcesContext = Depends(get_model_sources_context),
) -> ModelSourceResponse:
    try:
        updated = await context.service.update_source(source_id, payload)
    except ModelSourceNotFoundError as exc:
        raise DashboardNotFoundError(str(exc)) from exc
    except ModelSourceValidationError as exc:
        raise DashboardBadRequestError(str(exc), code="invalid_model_source_payload") from exc
    AuditService.log_async(
        "model_source_updated",
        actor_ip=request.client.host if request.client else None,
        actor=AuditActor.from_principal(principal),
        target=AuditTarget("model_source", updated.id),
        details={"source_id": updated.id},
    )
    return updated


@router.delete("/{source_id}")
async def delete_model_source(
    request: Request,
    source_id: str,
    principal: DashboardPrincipal = Depends(require_dashboard_write_access),
    context: ModelSourcesContext = Depends(get_model_sources_context),
) -> Response:
    try:
        await context.service.delete_source(source_id)
    except ModelSourceNotFoundError as exc:
        raise DashboardNotFoundError(str(exc)) from exc
    AuditService.log_async(
        "model_source_deleted",
        actor_ip=request.client.host if request.client else None,
        actor=AuditActor.from_principal(principal),
        target=AuditTarget("model_source", source_id),
        details={"source_id": source_id},
    )
    return Response(status_code=204)


@router.get("/{source_id}/quota", response_model=ModelSourceQuotaResponse)
async def get_google_source_quota(
    source_id: str,
    context: ModelSourcesContext = Depends(get_model_sources_context),
) -> ModelSourceQuotaResponse:
    source = await context.repository.get_by_id(source_id)
    if source is None:
        raise DashboardNotFoundError("Model source not found")
    snapshot = await context.session.get(GeminiQuota, source_id)
    if snapshot is None:
        return ModelSourceQuotaResponse()
    return ModelSourceQuotaResponse(
        buckets=json.loads(snapshot.snapshot_json)["buckets"], updated_at=snapshot.updated_at
    )


@router.post("/{source_id}/quota", response_model=ModelSourceQuotaResponse)
async def refresh_google_source_quota(
    request: Request,
    source_id: str,
    principal: DashboardPrincipal = Depends(require_dashboard_write_access),
    context: ModelSourcesContext = Depends(get_model_sources_context),
) -> ModelSourceQuotaResponse:
    source = await context.repository.get_by_id(source_id)
    if source is None:
        raise DashboardNotFoundError("Model source not found")
    if source.kind != "gemini_code_assist":
        raise DashboardBadRequestError("Only Code Assist exposes Google quota; API-key quota is unknown")
    try:
        result = await google_json(source, "/v1internal:retrieveUserQuota", {})
        await save_quota(source_id, result)
    except GoogleError as error:
        raise DashboardBadRequestError(str(error), code="google_quota_failed") from None
    AuditService.log_async(
        "model_source_quota_refreshed",
        actor_ip=request.client.host if request.client else None,
        actor=AuditActor.from_principal(principal),
        target=AuditTarget("model_source", source_id),
        details={"source_id": source_id},
    )
    return ModelSourceQuotaResponse.model_validate({"buckets": result["buckets"], "updatedAt": utcnow()})
