import { useFormContext, useWatch, type Control } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type {
  ModelSourceDraft,
  ModelSourceFormValues,
} from "@/features/model-sources/components/model-source-form";
import { parseReasoningEffortsInput } from "@/features/model-sources/components/model-source-form";

type ModelSourceFormFieldsProps = {
  control: Control<ModelSourceFormValues>;
  draft: ModelSourceDraft;
  updateDraft: (patch: Partial<ModelSourceDraft>) => void;
  apiKeyLabel: string;
  apiKeyPlaceholder?: string;
  immutableKind?: string;
};

const PROVIDERS = [
  { kind: "openai_compatible", label: "OpenAI-compatible", baseUrl: "" },
  {
    kind: "gemini_api_key",
    label: "Google Gemini API key",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  {
    kind: "gemini_code_assist",
    label: "Google Gemini Code Assist (OAuth)",
    baseUrl: "https://cloudcode-pa.googleapis.com",
  },
];

const CAPABILITY_TOGGLES = [
  ["supportsChatCompletions", "modelSources.capabilities.chatCompletions"] as const,
  ["supportsResponses", "modelSources.capabilities.responses"] as const,
  ["supportsAudioTranscriptions", "modelSources.capabilities.audioTranscriptions"] as const,
  ["supportsEmbeddings", "modelSources.capabilities.embeddings"] as const,
  ["supportsStreaming", "modelSources.capabilities.streaming"] as const,
  ["supportsTools", "modelSources.capabilities.tools"] as const,
  ["supportsVision", "modelSources.capabilities.vision"] as const,
  ["supportsReasoning", "modelSources.capabilities.reasoning"] as const,
];

const DEFAULT_REASONING_EFFORTS = ["low", "medium", "high"];

export function ModelSourceFormFields({
  control,
  draft,
  updateDraft,
  apiKeyLabel,
  apiKeyPlaceholder,
  immutableKind,
}: ModelSourceFormFieldsProps) {
  const { t } = useTranslation();
  const { setValue, getValues } = useFormContext<ModelSourceFormValues>();
  const kind = useWatch({ control, name: "kind" }) ?? "openai_compatible";
  const isGoogle = kind === "gemini_api_key" || kind === "gemini_code_assist";
  return (
    <>
      {immutableKind ? (
        <div className="space-y-1">
          <div className="text-sm font-medium">Provider (cannot be changed)</div>
          <div className="text-sm text-muted-foreground">
            {PROVIDERS.find((provider) => provider.kind === immutableKind)?.label ?? immutableKind}
          </div>
        </div>
      ) : (
        <FormField
          control={control}
          name="kind"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Provider</FormLabel>
              <Select
                value={field.value}
                onValueChange={(value) => {
                  const currentUrl = getValues("baseUrl");
                  if (!currentUrl || PROVIDERS.some((provider) => provider.baseUrl === currentUrl)) {
                    setValue(
                      "baseUrl",
                      PROVIDERS.find((provider) => provider.kind === value)?.baseUrl ?? "",
                      { shouldDirty: true },
                    );
                  }
                  // Do not accidentally send a credential to a different provider.
                  setValue("apiKey", "");
                  field.onChange(value);
                }}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {PROVIDERS.map((provider) => (
                    <SelectItem key={provider.kind} value={provider.kind}>
                      {provider.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          control={control}
          name="name"
          render={({ field }) => (
            <FormItem>
	              <FormLabel>{t("apiKeys.table.name")}</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="baseUrl"
          render={({ field }) => (
            <FormItem>
	              <FormLabel>{t("modelSources.fields.baseUrl")}</FormLabel>
              <FormControl>
                <Input {...field} placeholder="https://api.example.com/v1" autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={control}
        name="apiKey"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{kind === "gemini_code_assist" ? "OAuth JSON" : apiKeyLabel}</FormLabel>
            <FormControl>
              <Input {...field} type="password" autoComplete="new-password" placeholder={apiKeyPlaceholder} />
            </FormControl>
            {isGoogle ? (
              <p className="text-xs text-muted-foreground">
                {kind === "gemini_code_assist"
                  ? "Paste OAuth JSON with project, access_token and expiry_date (epoch milliseconds). For refresh, include refresh_token and matching client_id/client_secret. quota_scope is optional."
                  : "Paste a raw Gemini API key or credential JSON."}
                {immutableKind ? " Leave blank to retain the existing credential." : ""}
              </p>
            ) : null}
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="models"
        render={({ field }) => (
          <FormItem>
	            <FormLabel>{t("apiKeys.table.models")}</FormLabel>
            <FormControl>
              <Input {...field} placeholder={isGoogle ? "gemini-2.5-flash, gemini-2.5-pro" : "deepseek-v4-flash, local-coder"} autoComplete="off" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
	          <label className="text-sm font-medium">{t("modelSources.fields.contextWindow")}</label>
          <Input
            value={draft.contextWindow}
            onChange={(event) => updateDraft({ contextWindow: event.target.value })}
            placeholder="e.g. 32768"
            inputMode="numeric"
          />
        </div>
        <div className="space-y-1">
	          <label className="text-sm font-medium">{t("modelSources.fields.maxOutputTokens")}</label>
          <Input
            value={draft.maxOutputTokens}
            onChange={(event) => updateDraft({ maxOutputTokens: event.target.value })}
            placeholder="e.g. 4096"
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="space-y-2">
	        <div className="text-sm font-medium">{t("modelSources.fields.pricing")}</div>
	        <p className="text-xs text-muted-foreground">
	          {t("modelSources.fields.pricingDescription")}
	        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
	            <label className="text-xs text-muted-foreground">{t("common.units.input")}</label>
            <Input
              value={draft.inputPer1M}
              onChange={(event) => updateDraft({ inputPer1M: event.target.value })}
              placeholder="0.00"
              inputMode="decimal"
            />
          </div>
          <div className="space-y-1">
	            <label className="text-xs text-muted-foreground">{t("common.units.cached")}</label>
            <Input
              value={draft.cachedInputPer1M}
              onChange={(event) => updateDraft({ cachedInputPer1M: event.target.value })}
              placeholder="0.00"
              inputMode="decimal"
            />
          </div>
          <div className="space-y-1">
	            <label className="text-xs text-muted-foreground">{t("common.units.output")}</label>
            <Input
              value={draft.outputPer1M}
              onChange={(event) => updateDraft({ outputPer1M: event.target.value })}
              placeholder="0.00"
              inputMode="decimal"
            />
          </div>
        </div>
      </div>

      {!isGoogle ? <div className="space-y-2">
	        <div className="text-sm font-medium">{t("modelSources.fields.audioPricing")}</div>
	        <p className="text-xs text-muted-foreground">
	          {t("modelSources.fields.audioPricingDescription")}
	        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
	            <label className="text-xs text-muted-foreground">{t("modelSources.fields.perMinute")}</label>
            <Input
              value={draft.audioPerMinute}
              onChange={(event) => updateDraft({ audioPerMinute: event.target.value })}
              placeholder="0.00"
              inputMode="decimal"
            />
          </div>
        </div>
      </div> : null}

      <div className="grid gap-2 sm:grid-cols-2">
	        {CAPABILITY_TOGGLES.filter(([key]) => !isGoogle || ["supportsStreaming", "supportsTools", "supportsVision"].includes(key)).map(([key, labelKey]) => (
          <label key={key} className="flex items-center gap-2 rounded-md border p-2 text-sm">
            <Checkbox
              checked={draft[key]}
              onCheckedChange={(checked) =>
                updateDraft({
                  [key]: checked === true,
                  ...(key === "supportsReasoning" && checked === true
                    ? {
                        reasoningEffortsInput:
                          draft.reasoningEffortsInput || DEFAULT_REASONING_EFFORTS.join(", "),
                        reasoningEfforts:
                          draft.reasoningEfforts.length > 0
                            ? draft.reasoningEfforts
                            : DEFAULT_REASONING_EFFORTS,
                        defaultReasoningEffort: draft.defaultReasoningEffort || "medium",
                      }
                    : {}),
                })
              }
            />
	            {t(labelKey)}
          </label>
        ))}
      </div>

      {!isGoogle && draft.supportsReasoning ? (
        <div className="space-y-3 rounded-md border p-3">
          <div>
            <div className="text-sm font-medium">{t("modelSources.fields.reasoningEfforts")}</div>
            <p className="text-xs text-muted-foreground">
              {t("modelSources.fields.reasoningEffortsDescription")}
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="model-source-reasoning-efforts">
              {t("modelSources.fields.reasoningEfforts")}
            </label>
            <Input
              id="model-source-reasoning-efforts"
              aria-label={t("modelSources.fields.reasoningEfforts")}
              value={draft.reasoningEffortsInput}
              onChange={(event) => {
                const reasoningEffortsInput = event.target.value;
                const reasoningEfforts = parseReasoningEffortsInput(reasoningEffortsInput);
                updateDraft({
                  reasoningEffortsInput,
                  reasoningEfforts,
                  defaultReasoningEffort: reasoningEfforts.includes(draft.defaultReasoningEffort)
                    ? draft.defaultReasoningEffort
                    : (reasoningEfforts[0] ?? ""),
                });
              }}
              placeholder={t("modelSources.fields.reasoningEffortsPlaceholder")}
              autoComplete="off"
            />
          </div>

          <div className="space-y-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor="model-source-default-reasoning-effort"
            >
              {t("modelSources.fields.defaultReasoningEffort")}
            </label>
            <Select
              value={draft.defaultReasoningEffort}
              onValueChange={(value) => updateDraft({ defaultReasoningEffort: value })}
              disabled={draft.reasoningEfforts.length === 0}
            >
              <SelectTrigger
                id="model-source-default-reasoning-effort"
                aria-label={t("modelSources.fields.defaultReasoningEffort")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {draft.reasoningEfforts.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {effort}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
    </>
  );
}
