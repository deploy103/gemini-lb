import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { AlertMessage } from "@/components/alert-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { startGoogleConnection } from "@/features/model-sources/api";
import type { GoogleConnectionCompleteRequest, GoogleSourceKind, ModelSourceCreateRequest } from "@/features/model-sources/schemas";
import { getErrorMessageOrNull } from "@/utils/errors";

type Props = {
  busy: boolean;
  onClose: () => void;
  onCreate: (payload: ModelSourceCreateRequest) => Promise<unknown>;
  onConnect: (payload: GoogleConnectionCompleteRequest) => Promise<unknown>;
};

export function GeminiAccountDialog({ busy, onClose, onCreate, onConnect }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"google" | "apiKey" | "import">("google");
  const [kind, setKind] = useState<GoogleSourceKind>("gemini_antigravity");
  const [allowFreeSetup, setAllowFreeSetup] = useState(false);
  const [name, setName] = useState("");
  const [models, setModels] = useState("");
  const [secret, setSecret] = useState("");
  const [project, setProject] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({ mutationFn: () => startGoogleConnection(kind) });
  const working = busy || start.isPending;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const modelInputs = [...new Set(models.split(/[,\n]/).map((id) => id.trim()).filter(Boolean))]
      .map((model) => ({ model, supportsStreaming: true, supportsTools: true, supportsVision: true }));
    try {
      if (mode === "google" && start.data) {
        if (kind === "gemini_antigravity") {
          let callback: URL;
          try { callback = new URL(code.trim()); }
          catch { throw new Error(t("gemini.accounts.callbackHelp")); }
          if (callback.origin !== "http://localhost:51121" || callback.pathname !== "/oauth-callback" ||
            !callback.searchParams.get("code") || !callback.searchParams.get("state")) {
            throw new Error(t("gemini.accounts.callbackHelp"));
          }
        }
        await onConnect({
          transaction: start.data.transaction, code: code.trim(), name: name.trim() || undefined,
          project: kind === "gemini_code_assist" ? project.trim() || undefined : undefined,
          allowFreeSetup: kind === "gemini_antigravity" && allowFreeSetup, models: modelInputs,
        });
      } else if (mode !== "google") {
        await onCreate({
          name: name.trim(), kind: mode === "apiKey" ? "gemini_api_key" : kind,
          baseUrl: mode === "apiKey" ? "https://generativelanguage.googleapis.com" : kind === "gemini_antigravity" ? "https://daily-cloudcode-pa.googleapis.com" : "https://cloudcode-pa.googleapis.com",
          apiKey: secret.trim(), supportsChatCompletions: false, supportsResponses: false, models: modelInputs,
        });
      } else {
        return;
      }
      onClose();
    } catch (failure) {
      setError(getErrorMessageOrNull(failure));
      if (mode === "google") { setCode(""); start.reset(); }
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !working) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pr-12">
          <DialogTitle>{t("gemini.accounts.add")}</DialogTitle>
          <DialogDescription>{t("gemini.accounts.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { void submit(event); }} className="flex min-h-0 flex-col">
          <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-5">
            <fieldset disabled={working} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <legend className="sr-only">Provider</legend>
              {(["google", "apiKey", "import"] as const).map((option) => (
                <label key={option} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm">
                  <input type="radio" name="gemini-connection" checked={mode === option} onChange={() => {
                    setMode(option); setSecret(""); setCode(""); setError(null); start.reset();
                  }} />
                  {t(`gemini.accounts.${option}`)}
                </label>
              ))}
            </fieldset>
            {mode !== "apiKey" && <fieldset disabled={working} className="space-y-2">
              <legend className="text-sm font-medium">{t("gemini.accounts.provider")}</legend>
              {(["gemini_antigravity", "gemini_code_assist"] as const).map((provider) => <label key={provider} className="flex items-center gap-2 text-sm">
                <input type="radio" name="google-provider" checked={kind === provider} onChange={() => {
                  setKind(provider); setSecret(""); setCode(""); setError(null); start.reset();
                }} />{t(`gemini.accounts.${provider}`)}
              </label>)}
            </fieldset>}
            {error || start.error ? <AlertMessage variant="error">{error ?? getErrorMessageOrNull(start.error)}</AlertMessage> : null}
            <label className="block space-y-1.5 text-sm font-medium">
              {t("apiKeys.table.name")}
              <Input value={name} onChange={(event) => setName(event.target.value)} required={mode !== "google"}
                maxLength={128} disabled={working} autoComplete="off" placeholder={mode === "google" ? "Google email" : "Gemini"} />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              {t("apiKeys.table.models")}
              <Input value={models} onChange={(event) => setModels(event.target.value)} disabled={working}
                autoComplete="off" placeholder="gemini-2.5-flash, gemini-2.5-pro" />
            </label>
            <p className="text-xs text-muted-foreground">{t("gemini.discovery.optionalModels")}</p>
            {mode === "google" ? <>
              {kind === "gemini_code_assist" && <><label className="block space-y-1.5 text-sm font-medium">
                {t("gemini.accounts.project")}
                <Input value={project} onChange={(event) => setProject(event.target.value)} disabled={working}
                  maxLength={256} autoComplete="off" placeholder="Auto-detect" />
              </label>
              <p className="text-xs text-muted-foreground">{t("gemini.accounts.projectHelp")}</p></>}
              {kind === "gemini_antigravity" && <>
                <p className="text-xs text-muted-foreground">{t("gemini.accounts.personalHelp")}</p>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={allowFreeSetup} disabled={working} onChange={(event) => setAllowFreeSetup(event.target.checked)} />
                  {t("gemini.accounts.freeConsent")}
                </label>
              </>}
              <Button type="button" variant="outline" disabled={working} onClick={() => { setCode(""); setError(null); start.reset(); start.mutate(); }}>
                {t("gemini.accounts.start")}
              </Button>
              {start.data ? <div className="space-y-3 rounded-lg border p-4">
                <Button asChild><a href={start.data.authorizationUrl} target="_blank" rel="noopener noreferrer">
                  {t("gemini.accounts.openGoogle")}
                </a></Button>
                <p className="text-xs text-muted-foreground">{t(kind === "gemini_antigravity" ? "gemini.accounts.callbackHelp" : "gemini.accounts.codeHelp")}</p>
                <label className="block space-y-1.5 text-sm font-medium">
                  {t(kind === "gemini_antigravity" ? "gemini.accounts.callback" : "gemini.accounts.code")}
                  <Input type="password" value={code} onChange={(event) => setCode(event.target.value)} required
                    disabled={working} maxLength={2048} autoComplete="new-password" />
                </label>
              </div> : null}
            </> : <>
              <label className="block space-y-1.5 text-sm font-medium">
                {mode === "apiKey" ? t("gemini.accounts.apiKey") : "OAuth JSON"}
                <Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} required
                  disabled={working} autoComplete="new-password" />
              </label>
              <p className="text-xs text-muted-foreground">
                {t(mode === "apiKey" ? "gemini.accounts.unknownQuota" : "gemini.accounts.importHelp")}
              </p>
            </>}
          </div>
          <DialogFooter className="shrink-0 border-t px-6 py-4">
            <Button type="button" variant="outline" disabled={working} onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={working || (mode === "google" && (!start.data || !code.trim()))}>
              {t("gemini.accounts.connect")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
