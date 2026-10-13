import { z } from "zod";

export const ModelSourceQuotaSchema = z.object({
  buckets: z.array(z.object({
    modelId: z.string().optional(),
    remainingFraction: z.number().min(0).max(1).optional(),
    remainingAmount: z.string().optional(),
    resetTime: z.string().optional(),
    tokenType: z.string().optional(),
  })),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});

export const ModelSourceModelSchema = z.object({
  id: z.number(),
  sourceId: z.string(),
  model: z.string(),
  displayName: z.string().nullable().default(null),
  contextWindow: z.number().int().positive().nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  supportsStreaming: z.boolean().default(true),
  supportsTools: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  inputPer1M: z.number().nullable().default(null),
  cachedInputPer1M: z.number().nullable().default(null),
  outputPer1M: z.number().nullable().default(null),
  audioPerMinute: z.number().nullable().default(null),
  rawMetadataJson: z.string().nullable().default(null),
  isEnabled: z.boolean().default(true),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const ModelSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  baseUrl: z.string(),
  isEnabled: z.boolean(),
  healthStatus: z.string(),
  supportsChatCompletions: z.boolean(),
  supportsResponses: z.boolean(),
  supportsAudioTranscriptions: z.boolean().default(false),
  supportsEmbeddings: z.boolean().default(false),
  timeoutSeconds: z.number().int().positive().nullable().default(null),
  maxConcurrency: z.number().int().positive().nullable().default(null),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  models: z.array(ModelSourceModelSchema).default([]),
});

export const ModelSourcesResponseSchema = z.object({
  sources: z.array(ModelSourceSchema).default([]),
});

export const GoogleConnectionSchema = z.object({
  authorizationUrl: z.url(),
  transaction: z.string(),
  expiresIn: z.number(),
  kind: z.enum(["gemini_antigravity", "gemini_code_assist"]).default("gemini_code_assist"),
});

export type GoogleSourceKind = "gemini_antigravity" | "gemini_code_assist";

export type GoogleConnectionCompleteRequest = {
  transaction: string;
  code: string;
  name?: string;
  project?: string;
  allowFreeSetup?: boolean;
  models: ModelSourceModelInput[];
};

export const ModelSourceModelInputSchema = z.object({
  model: z.string().min(1).max(255),
  displayName: z.string().max(255).nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  inputPer1M: z.number().nonnegative().nullable().optional(),
  cachedInputPer1M: z.number().nonnegative().nullable().optional(),
  outputPer1M: z.number().nonnegative().nullable().optional(),
  audioPerMinute: z.number().nonnegative().nullable().optional(),
  rawMetadataJson: z.string().nullable().optional(),
  isEnabled: z.boolean().optional(),
});

export const ModelSourceCreateRequestSchema = z.object({
  name: z.string().min(1).max(128),
  kind: z.enum(["openai_compatible", "gemini_api_key", "gemini_code_assist", "gemini_antigravity"]).optional(),
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().min(1).nullable().optional(),
  supportsChatCompletions: z.boolean().optional(),
  supportsResponses: z.boolean().optional(),
  supportsAudioTranscriptions: z.boolean().optional(),
  supportsEmbeddings: z.boolean().optional(),
  timeoutSeconds: z.number().int().positive().nullable().optional(),
  maxConcurrency: z.number().int().positive().nullable().optional(),
  models: z.array(ModelSourceModelInputSchema).default([]),
});

export const ModelSourceUpdateRequestSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  baseUrl: z.string().min(1).max(2048).optional(),
  apiKey: z.string().min(1).nullable().optional(),
  isEnabled: z.boolean().optional(),
  supportsChatCompletions: z.boolean().optional(),
  supportsResponses: z.boolean().optional(),
  supportsAudioTranscriptions: z.boolean().optional(),
  supportsEmbeddings: z.boolean().optional(),
  timeoutSeconds: z.number().int().positive().nullable().optional(),
  maxConcurrency: z.number().int().positive().nullable().optional(),
  models: z.array(ModelSourceModelInputSchema).optional(),
});

export type ModelSource = z.infer<typeof ModelSourceSchema>;
export type ModelSourceModel = z.infer<typeof ModelSourceModelSchema>;
export type ModelSourceModelInput = z.infer<typeof ModelSourceModelInputSchema>;
export type ModelSourceCreateRequest = z.infer<typeof ModelSourceCreateRequestSchema>;
export type ModelSourceUpdateRequest = z.infer<typeof ModelSourceUpdateRequestSchema>;

export const GoogleDiscoverySchema = z.object({
  origin: z.enum(["catalog", "quota", "antigravity"]),
  models: z.array(ModelSourceModelInputSchema),
  checkedAt: z.iso.datetime({ offset: true }),
  elapsedMs: z.number().int().nonnegative(),
});
