import { del, get, patch, post } from "@/lib/api-client";

import {
  GoogleConnectionSchema,
  type GoogleConnectionCompleteRequest,
  GoogleDiscoverySchema,
  ModelSourceCreateRequestSchema,
  ModelSourceQuotaSchema,
  ModelSourceSchema,
  ModelSourcesResponseSchema,
  ModelSourceUpdateRequestSchema,
} from "@/features/model-sources/schemas";

const MODEL_SOURCES_PATH = "/api/model-sources";

export function startGoogleConnection() {
  return post(`${MODEL_SOURCES_PATH}/google/start`, GoogleConnectionSchema);
}

export function completeGoogleConnection(payload: GoogleConnectionCompleteRequest) {
  return post(`${MODEL_SOURCES_PATH}/google/complete`, ModelSourceSchema, { body: payload });
}

export function getModelSourceQuota(sourceId: string) {
  return get(`${MODEL_SOURCES_PATH}/${encodeURIComponent(sourceId)}/quota`, ModelSourceQuotaSchema);
}

export function refreshModelSourceQuota(sourceId: string) {
  return post(`${MODEL_SOURCES_PATH}/${encodeURIComponent(sourceId)}/quota`, ModelSourceQuotaSchema);
}

export function discoverGoogleModels(sourceId: string) {
  return post(`${MODEL_SOURCES_PATH}/${encodeURIComponent(sourceId)}/discover`, GoogleDiscoverySchema);
}

export function listModelSources() {
  return get(`${MODEL_SOURCES_PATH}/`, ModelSourcesResponseSchema);
}

export function createModelSource(payload: unknown) {
  const validated = ModelSourceCreateRequestSchema.parse(payload);
  return post(`${MODEL_SOURCES_PATH}/`, ModelSourceSchema, {
    body: validated,
  });
}

export function updateModelSource(sourceId: string, payload: unknown) {
  const validated = ModelSourceUpdateRequestSchema.parse(payload);
  return patch(`${MODEL_SOURCES_PATH}/${encodeURIComponent(sourceId)}`, ModelSourceSchema, {
    body: validated,
  });
}

export function deleteModelSource(sourceId: string) {
  return del(`${MODEL_SOURCES_PATH}/${encodeURIComponent(sourceId)}`);
}
