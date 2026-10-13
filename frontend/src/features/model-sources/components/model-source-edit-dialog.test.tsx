import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders } from "@/test/utils";
import { server } from "@/test/mocks/server";
import { ModelSourceSchema, ModelSourceUpdateRequestSchema, type ModelSource } from "@/features/model-sources/schemas";

import { ModelSourceEditDialog } from "./model-source-edit-dialog";
import { ModelSourceCreateDialog } from "./model-source-create-dialog";
import { GoogleSourceDiagnosticsDialog } from "./google-source-diagnostics-dialog";
import { GeminiAccountDialog } from "./gemini-account-dialog";
import { ModelSourcesSettings } from "./model-sources-settings";
import { completeGoogleConnection, createModelSource as createSource, listModelSources, updateModelSource } from "@/features/model-sources/api";

function createModelSource(overrides: Partial<ModelSource> = {}): ModelSource {
  return {
    id: "src_1",
    name: "vllm-local",
    kind: "openai_compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    isEnabled: true,
    healthStatus: "unknown",
    supportsChatCompletions: true,
    supportsResponses: false,
    supportsAudioTranscriptions: false,
    supportsEmbeddings: false,
    timeoutSeconds: null,
    maxConcurrency: null,
    createdAt: "2026-07-03T00:00:00Z",
    updatedAt: "2026-07-03T00:00:00Z",
    models: [
      {
        id: 1,
        sourceId: "src_1",
        model: "Qwen/Qwen3.6-27B-FP8",
        displayName: "Qwen/Qwen3.6-27B-FP8",
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
        inputPer1M: 0.5,
        cachedInputPer1M: null,
        outputPer1M: 1.5,
        audioPerMinute: null,
        rawMetadataJson: null,
        isEnabled: true,
        createdAt: "2026-07-03T00:00:00Z",
        updatedAt: "2026-07-03T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("ModelSourceEditDialog", () => {
  it.each(["gemini_code_assist", "gemini_antigravity"])("loads only saved %s quota and explicitly refreshes observed buckets, retaining them on failure", async (kind) => {
    const user = userEvent.setup();
    const getQuota = vi.fn(() => HttpResponse.json({ buckets: [], updatedAt: null }));
    const postQuota = vi.fn()
      .mockImplementationOnce(() => HttpResponse.json({ buckets: [
        { modelId: "gemini-2.5-flash", remainingFraction: 0, remainingAmount: "0", tokenType: "REQUESTS", resetTime: "2026-10-13T00:00:00Z" },
        { modelId: "gemini-2.5-pro", unrecognizedMetric: 999 },
      ], updatedAt: "2026-10-12T00:00:00Z" }))
      .mockImplementation(() => HttpResponse.json({ error: { code: "upstream_error", message: "Unavailable" } }, { status: 502 }));
    server.use(http.get("/api/model-sources/:sourceId/quota", getQuota), http.post("/api/model-sources/:sourceId/quota", postQuota));
    const props = { open: true, busy: false, onOpenChange: vi.fn(), onSubmit: vi.fn() };
    const apiKeyView = renderWithProviders(<ModelSourceEditDialog {...props} source={createModelSource({ kind: "gemini_api_key" })} />);
    expect(screen.queryByRole("button", { name: "Refresh quota" })).not.toBeInTheDocument();
    expect(getQuota).not.toHaveBeenCalled();
    apiKeyView.unmount();
    renderWithProviders(<ModelSourceEditDialog {...props} source={createModelSource({ kind })} />);
    expect(await screen.findByText("Quota unknown — not yet queried.")).toBeInTheDocument();
    expect(postQuota).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Refresh quota" }));
    expect(await screen.findByText("Remaining: 0%")).toBeInTheDocument();
    expect(screen.getByText("Remaining amount: 0")).toBeInTheDocument();
    expect(screen.getByText("Remaining percentage: unknown")).toBeInTheDocument();
    expect(screen.queryByText(/999/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh quota" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Quota could not be refreshed");
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByText("Remaining: 0%")).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ["gemini_api_key", "Google Gemini API key", "https://generativelanguage.googleapis.com", "test-api-key"],
    ["gemini_antigravity", "Google Antigravity personal account (OAuth)", "https://daily-cloudcode-pa.googleapis.com", JSON.stringify({ project: "personal-project", access_token: "personal-token", expiry_date: 1900000000000 })],
    ["gemini_code_assist", "Google Gemini Code Assist (OAuth)", "https://cloudcode-pa.googleapis.com", JSON.stringify({ project: "test-project", access_token: "test-token", expiry_date: 1900000000000 })],
  ])("creates and edits %s through the public API without exposing or replacing secrets", async (kind, label, baseUrl, secret) => {
    const user = userEvent.setup();
    const onCreate = vi.fn(createSource);
    const createView = renderWithProviders(
      <ModelSourceCreateDialog open busy={false} onOpenChange={vi.fn()} onSubmit={async (payload) => { await onCreate(payload); }} />,
    );
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("OpenAI-compatible");
    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("option", { name: label }));
    expect(screen.getByLabelText("Base URL")).toHaveValue(baseUrl);
    await user.type(screen.getByLabelText("Name"), "Google source");
    await user.type(screen.getByLabelText("Models"), "gemini-2.5-flash");
    const secretInput = screen.getByLabelText(kind !== "gemini_api_key" ? "OAuth JSON" : "Upstream API key");
    expect(secretInput).toHaveAttribute("type", "password");
    await user.click(secretInput);
    await user.paste(secret);
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const source = await onCreate.mock.results[0].value;
    expect(source.kind).toBe(kind);
    expect(source.models[0].model).toBe("gemini-2.5-flash");
    expect(onCreate.mock.calls[0][0]).toMatchObject({ apiKey: secret });
    createView.unmount();

    const onEdit = vi.fn(updateModelSource);
    renderWithProviders(
      <ModelSourceEditDialog open busy={false} source={source} onOpenChange={vi.fn()} onSubmit={async (id, payload) => { await onEdit(id, payload); }} />,
    );
    expect(screen.getByText("Provider (cannot be changed)")).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(kind !== "gemini_api_key" ? "OAuth JSON" : "Upstream API key")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    expect(onEdit.mock.calls[0][1]).not.toHaveProperty("apiKey");
    expect(onEdit.mock.calls[0][1]).not.toHaveProperty("kind");
    expect((await onEdit.mock.results[0].value).kind).toBe(kind);
  });

  it.each([false, true])("connects personal accounts with full callback and consent=%s, resetting a consumed login on failure", async (consent) => {
    const user = userEvent.setup();
    let attempt = 0;
    let completeCount = 0;
    const callback = "http://localhost:51121/oauth-callback?code=personal-code&state=personal-state";
    server.use(
      http.post("/api/model-sources/google/start", async ({ request }) => {
        const body = await request.json();
        if (JSON.stringify(body) !== JSON.stringify({ kind: "gemini_antigravity" })) return new HttpResponse(null, { status: 400 });
        attempt += 1;
        return HttpResponse.json({ authorizationUrl: `https://accounts.google.com/login?attempt=${attempt}`, transaction: `login-${attempt}`, expiresIn: 600, kind: "gemini_antigravity" });
      }),
      http.post("/api/model-sources/google/complete", async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        if (body.code !== callback || body.allowFreeSetup !== consent || body.transaction !== `login-${attempt}` || "kind" in body || "project" in body) {
          return HttpResponse.json({ error: { message: "Invalid personal connection payload" } }, { status: 400 });
        }
        completeCount += 1;
        if (completeCount === 1) return HttpResponse.json({ error: { code: "upstream_error", message: "Google requires a fresh login" } }, { status: 502 });
        return HttpResponse.json(createModelSource({ kind: "gemini_antigravity", healthStatus: "unknown" }));
      }),
    );
    const close = vi.fn();
    renderWithProviders(<GeminiAccountDialog busy={false} onClose={close} onCreate={createSource} onConnect={completeGoogleConnection} />);
    expect(screen.getByRole("radio", { name: /Personal \/ free \/ AI Pro/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Enterprise Code Assist/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Allow free initialization/ })).not.toBeChecked();
    if (consent) await user.click(screen.getByRole("checkbox", { name: /Allow free initialization/ }));
    await user.click(screen.getByRole("button", { name: "Start Google login" }));
    expect(await screen.findByRole("link", { name: "Open Google sign-in" })).toHaveAttribute("href", "https://accounts.google.com/login?attempt=1");
    await user.type(screen.getByLabelText("Full localhost callback URL"), callback);
    await user.click(screen.getByRole("button", { name: "Connect account" }));
    expect(await screen.findByText("Google requires a fresh login")).toBeInTheDocument();
    expect(screen.queryByLabelText("Full localhost callback URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Google sign-in" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect account" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Allow free initialization/ })).toHaveProperty("checked", consent);
    await user.click(screen.getByRole("button", { name: "Start Google login" }));
    expect(await screen.findByRole("link", { name: "Open Google sign-in" })).toHaveAttribute("href", "https://accounts.google.com/login?attempt=2");
    expect(screen.getByLabelText("Full localhost callback URL")).toHaveValue("");
    await user.type(screen.getByLabelText("Full localhost callback URL"), callback);
    await user.click(screen.getByRole("button", { name: "Connect account" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it.each(["gemini_antigravity", "gemini_code_assist"])("imports %s through the primary account controls and shows the registered source", async (kind) => {
    const user = userEvent.setup();
    renderWithProviders(<ModelSourcesSettings geminiOnly />);
    await user.click(await screen.findByRole("button", { name: "Add account" }));
    await user.click(screen.getByRole("radio", { name: "Import OAuth JSON" }));
    if (kind === "gemini_code_assist") await user.click(screen.getByRole("radio", { name: "Enterprise Code Assist (legacy)" }));
    await user.type(screen.getByLabelText("Name"), "Imported personal account");
    const credential = JSON.stringify({ project: "personal-project", access_token: "personal-token", expiry_date: 1900000000000 });
    await user.click(screen.getByLabelText("OAuth JSON"));
    await user.paste(credential);
    await user.click(screen.getByRole("button", { name: "Connect account" }));
    expect(await screen.findByText("Imported personal account")).toBeInTheDocument();
    expect(screen.queryByText(credential)).not.toBeInTheDocument();
    expect(screen.getByText(kind === "gemini_antigravity" ? "https://daily-cloudcode-pa.googleapis.com" : "https://cloudcode-pa.googleapis.com")).toBeInTheDocument();
    const saved = (await listModelSources()).sources.find((source) => source.name === "Imported personal account");
    expect(saved?.kind).toBe(kind);
    expect(saved?.healthStatus).toBe("unknown");
  });

  it("prefills existing fields including pricing and models", () => {
    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={createModelSource()}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("vllm-local");
    expect(screen.getByLabelText("Base URL")).toHaveValue("http://127.0.0.1:8000/v1");
    expect(screen.getByDisplayValue("Qwen/Qwen3.6-27B-FP8")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0.5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1.5")).toBeInTheDocument();
  });

  it("submits edited pricing and omits blank api key", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={createModelSource()}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const outputPrice = screen.getByDisplayValue("1.5");
    await user.clear(outputPrice);
    await user.type(outputPrice, "2.25");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const [sourceId, payload] = onSubmit.mock.calls[0];
    expect(sourceId).toBe("src_1");
    expect("apiKey" in payload).toBe(false);
    expect(payload.models).toHaveLength(1);
    expect(payload.models[0]).toMatchObject({
      model: "Qwen/Qwen3.6-27B-FP8",
      inputPer1M: 0.5,
      outputPer1M: 2.25,
    });
    expect(payload.supportsAudioTranscriptions).toBe(false);
    expect(payload.supportsEmbeddings).toBe(false);
  });

  it("carries an enabled embeddings capability through submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={createModelSource({ supportsEmbeddings: true })}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const [, payload] = onSubmit.mock.calls[0];
    expect(payload.supportsEmbeddings).toBe(true);
  });

  it("preserves disabled model rows during edits", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const source = createModelSource({
      models: [
        {
          ...createModelSource().models[0],
          model: "enabled-model",
          displayName: "enabled-model",
          isEnabled: true,
          contextWindow: 2048,
          supportsVision: true,
        },
        {
          ...createModelSource().models[0],
          id: 2,
          model: "disabled-model",
          displayName: "disabled-model",
          isEnabled: false,
          contextWindow: 4096,
          supportsVision: false,
        },
      ],
    });

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={source}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const outputPrice = screen.getByDisplayValue("1.5");
    await user.clear(outputPrice);
    await user.type(outputPrice, "2.0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    expect(onSubmit.mock.calls[0][1].models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "enabled-model",
          isEnabled: true,
          contextWindow: 2048,
          outputPer1M: 2,
          supportsVision: true,
        }),
        expect.objectContaining({
          model: "disabled-model",
          isEnabled: false,
          contextWindow: 4096,
          outputPer1M: 2,
          supportsVision: false,
        }),
      ]),
    );
  });

  it("omits model rows when only source-level fields changed", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const source = createModelSource({
      models: [
        {
          ...createModelSource().models[0],
          model: "m-one",
          displayName: "m-one",
          contextWindow: 2048,
          outputPer1M: 1.0,
        },
        {
          ...createModelSource().models[0],
          id: 2,
          model: "m-two",
          displayName: "m-two",
          contextWindow: 4096,
          outputPer1M: 2.0,
        },
      ],
    });

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={source}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "vllm-local-updated");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const payload = onSubmit.mock.calls[0][1];
    expect(payload.name).toBe("vllm-local-updated");
    expect(payload.models).toBeUndefined();
  });

  it("prefills and submits the audio per-minute rate", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const source = createModelSource();
    source.models[0].audioPerMinute = 0.3;

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={source}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const audioPrice = screen.getByDisplayValue("0.3");
    await user.clear(audioPrice);
    await user.type(audioPrice, "0.45");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    expect(onSubmit.mock.calls[0][1].models[0].audioPerMinute).toBe(0.45);
  });

  it("toggles reasoning support via raw metadata while keeping other keys", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const source = createModelSource();
    source.models[0].rawMetadataJson = '{"custom_key": "kept"}';

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={source}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Reasoning" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Reasoning" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const rawMetadata = JSON.parse(onSubmit.mock.calls[0][1].models[0].rawMetadataJson);
    expect(rawMetadata).toEqual({
      custom_key: "kept",
      supports_reasoning: true,
      supported_reasoning_levels: ["low", "medium", "high"],
      default_reasoning_level: "medium",
    });
  });

  it("prefills the reasoning toggle from raw metadata", () => {
    const source = createModelSource();
    source.models[0].rawMetadataJson = JSON.stringify({
      supports_reasoning: true,
      supported_reasoning_levels: [
        { effort: "none", description: "disable chain of thought" },
        "provider-specific",
        "ultra",
      ],
      default_reasoning_level: "provider-specific",
    });

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={source}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Reasoning" })).toBeChecked();
    expect(screen.getByLabelText("Supported reasoning efforts")).toHaveValue(
      "none, provider-specific, ultra",
    );
    expect(screen.getByRole("combobox", { name: "Default reasoning effort" })).toHaveTextContent(
      "provider-specific",
    );
  });

  it("keeps arbitrary reasoning efforts and renormalizes a stale default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const source = createModelSource();
    source.models[0].rawMetadataJson = JSON.stringify({
      supports_reasoning: true,
      supported_reasoning_levels: ["none", "provider-specific", "ultra"],
      default_reasoning_level: "provider-specific",
    });

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={source}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const reasoningEfforts = screen.getByLabelText("Supported reasoning efforts");
    await user.clear(reasoningEfforts);
    await user.type(reasoningEfforts, "none, custom-tier");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    const rawMetadata = JSON.parse(onSubmit.mock.calls[0][1].models[0].rawMetadataJson);
    expect(rawMetadata).toEqual({
      supports_reasoning: true,
      supported_reasoning_levels: ["none", "custom-tier"],
      default_reasoning_level: "none",
    });
  });

  it("sends the api key only when the field is filled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(
      <ModelSourceEditDialog
        open
        busy={false}
        source={createModelSource()}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText("Upstream API key"), "sk-new-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    expect(onSubmit.mock.calls[0][1].apiKey).toBe("sk-new-token");
  });
});

describe("GoogleSourceDiagnosticsDialog", () => {
  it.each(["catalog", "antigravity"])("reports failures and explicitly adds %s models without replacing current operator overrides", async (origin) => {
    const user = userEvent.setup();
    const source = createModelSource({ name: "Google discovery", kind: origin === "antigravity" ? "gemini_antigravity" : "gemini_api_key",
      models: [{ ...createModelSource().models[0], model: "gemini-2.5-flash", inputPer1M: 0.75,
        isEnabled: false, supportsVision: true }] });
    let saved = source;
    server.use(http.get("/api/model-sources/", () => HttpResponse.json({ sources: [saved] })),
      http.patch("/api/model-sources/:id", async ({ request }) => {
        const payload = ModelSourceUpdateRequestSchema.parse(await request.json());
        saved = ModelSourceSchema.parse({ ...saved, models: payload.models?.map((model, index) => ({
          ...model, id: index + 1, sourceId: saved.id, createdAt: saved.createdAt, updatedAt: saved.updatedAt,
        })) ?? saved.models });
        return HttpResponse.json(saved);
      }));
    let fail = true;
    server.use(http.post("/api/model-sources/:id/discover", () => fail
      ? HttpResponse.json({ error: { code: "google_discovery_failed", message: "Check Google project access." } }, { status: 400 })
      : HttpResponse.json({ origin, checkedAt: "2026-10-13T00:00:00Z", elapsedMs: 73,
        models: [{ model: "gemini-2.5-flash", inputPer1M: 0, supportsVision: false },
          { model: "gemini-2.5-pro", contextWindow: 4096, maxOutputTokens: 96 },
          { model: "text-embedding-004", supportsStreaming: false }] })));
    renderWithProviders(<GoogleSourceDiagnosticsDialog source={source} disabled={false} onClose={() => {}}
      onApply={async (id, payload) => { await updateModelSource(id, payload); }} />);
    const apply = screen.getByRole("button", { name: "Add selected models (0)" });
    expect(apply).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check connection and discover models" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check Google project access.");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Check connection and discover models" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Metadata check succeeded · 3 models · 73 ms");
    if (origin === "antigravity") expect(screen.getByText("Observed Antigravity account catalog from Google. Inference access and subscription status are not verified.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /gemini-2.5-flash/ })).toBeDisabled();
    await user.type(screen.getByLabelText("Search discovered models"), "pro");
    expect(screen.queryByRole("checkbox", { name: /text-embedding/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /gemini-2.5-pro/ }));
    // Another edit after opening the dialog must not be reverted by its old snapshot.
    await updateModelSource(source.id, { models: [{ model: "gemini-2.5-flash", inputPer1M: 9.5,
      isEnabled: false, supportsVision: true }, { model: "manual-model", outputPer1M: 4 }] });
    await user.click(screen.getByRole("button", { name: "Add selected models (1)" }));
    await waitFor(async () => {
      const saved = (await listModelSources()).sources.find((item) => item.id === source.id)!;
      expect(saved.models.map((model) => model.model)).toEqual(["gemini-2.5-flash", "manual-model", "gemini-2.5-pro"]);
      expect(saved.models[0]).toMatchObject({ inputPer1M: 9.5, isEnabled: false, supportsVision: true });
      expect(saved.models[1].outputPer1M).toBe(4);
      expect(saved.models[2]).toMatchObject({ contextWindow: 4096, maxOutputTokens: 96 });
    });
  });

  it("keeps diagnosis and apply unavailable to read-only users", () => {
    renderWithProviders(<GoogleSourceDiagnosticsDialog source={createModelSource({ kind: "gemini_api_key" })}
      disabled onClose={() => {}} onApply={async () => {}} />);
    expect(screen.getByRole("button", { name: "Check connection and discover models" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add selected models (0)" })).toBeDisabled();
  });
});
