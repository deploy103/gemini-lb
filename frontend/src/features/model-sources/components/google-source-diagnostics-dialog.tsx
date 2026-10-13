import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { discoverGoogleModels, listModelSources } from "@/features/model-sources/api";
import type { ModelSource, ModelSourceUpdateRequest } from "@/features/model-sources/schemas";
import { getErrorMessageOrNull } from "@/utils/errors";

type Props = {
  source: ModelSource;
  disabled: boolean;
  onClose: () => void;
  onApply: (sourceId: string, payload: ModelSourceUpdateRequest) => Promise<void>;
};

export function GoogleSourceDiagnosticsDialog({ source, disabled, onClose, onApply }: Props) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discovery = useMutation({
    mutationFn: () => discoverGoogleModels(source.id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["model-sources", "list"] });
      void client.invalidateQueries({ queryKey: ["model-sources", source.id, "quota"] });
    },
  });
  const busy = disabled || discovery.isPending || saving;
  const existing = new Set(source.models.map((model) => model.model));
  const visible = discovery.data?.models.filter((model) =>
    `${model.model} ${model.displayName ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  ) ?? [];

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      // Read current overrides rather than replacing them with discovery metadata.
      const latest = (await listModelSources()).sources.find((item) => item.id === source.id);
      if (!latest || !latest.isEnabled) throw new Error(t("gemini.discovery.changed"));
      const configured = new Set(latest.models.map((model) => model.model));
      const additions = discovery.data?.models.filter((model) => selected.includes(model.model) && !configured.has(model.model)) ?? [];
      if (additions.length > 0) await onApply(source.id, { models: [...latest.models, ...additions] });
      onClose();
    } catch (failure) {
      setError(getErrorMessageOrNull(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pr-12">
          <DialogTitle>{t("gemini.discovery.title")}</DialogTitle>
          <DialogDescription className="break-words">{source.name} · {t("gemini.discovery.description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-4">
          <Button type="button" variant="outline" className="h-auto max-w-full whitespace-normal" disabled={busy || !source.isEnabled} onClick={() => {
            setSelected([]); setError(null); discovery.mutate();
          }}>{t(discovery.isPending ? "gemini.discovery.checking" : "gemini.discovery.check")}</Button>
          {error || discovery.error ? <div role="alert"><AlertMessage variant="error">{error ?? getErrorMessageOrNull(discovery.error)}</AlertMessage></div> : null}
          {discovery.data ? <>
            <p role="status" className="text-sm text-muted-foreground">
              {t("gemini.discovery.result", { count: discovery.data.models.length, ms: discovery.data.elapsedMs })}
              {" · "}{new Date(discovery.data.checkedAt).toLocaleString()}
            </p>
            <p className="text-sm text-muted-foreground">{t(`gemini.discovery.${discovery.data.origin}`)}</p>
            <label className="block space-y-1.5 text-sm font-medium">
              {t("gemini.discovery.search")}
              <Input value={search} onChange={(event) => setSearch(event.target.value)} disabled={busy} />
            </label>
            <div className="space-y-2">
              {visible.map((model) => <label key={model.model} className="flex items-start gap-3 rounded-lg border p-3">
                <input type="checkbox" className="mt-1" disabled={busy || existing.has(model.model)}
                  checked={existing.has(model.model) || selected.includes(model.model)}
                  onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, model.model] : ids.filter((id) => id !== model.model))} />
                <span className="min-w-0 space-y-1 text-sm break-words">
                  <span className="block font-medium">{model.model}</span>
                  {model.displayName && <span className="block text-muted-foreground">{model.displayName}</span>}
                  <span className="block text-xs text-muted-foreground">
                    {existing.has(model.model) ? t("gemini.discovery.configured") : t("gemini.discovery.new")}
                    {model.contextWindow ? ` · ${t("gemini.discovery.inputTokens", { count: model.contextWindow })}` : ""}
                    {model.maxOutputTokens ? ` · ${t("gemini.discovery.outputTokens", { count: model.maxOutputTokens })}` : ""}
                  </span>
                </span>
              </label>)}
              {visible.length === 0 && <p className="text-sm text-muted-foreground">{t("gemini.discovery.empty")}</p>}
            </div>
          </> : null}
          <p className="text-xs text-muted-foreground">{t("gemini.discovery.preserve")}</p>
        </div>
        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="button" disabled={busy || selected.length === 0} onClick={() => { void apply(); }}>
            {t("gemini.discovery.apply", { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
