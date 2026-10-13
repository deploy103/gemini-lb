import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { ModelSourcesSettings } from "@/features/model-sources/components/model-sources-settings";

export function GeminiAccountsPage() {
  const { t } = useTranslation();
  const canWrite = useAuthStore((state) => state.canWrite);
  return (
    <div className="animate-fade-in-up space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("gemini.accounts.title")}</h1>
      <ModelSourcesSettings geminiOnly disabled={!canWrite} />
      <div className="space-y-2 rounded-xl border bg-card p-5 text-sm">
        <p className="font-medium">{t("gemini.accounts.native")}</p>
        <p className="break-all font-mono text-xs">Antigravity (free / AI Pro): {window.location.origin}/antigravity</p>
        <p className="break-all font-mono text-xs">Gemini API: {window.location.origin}/gemini/v1beta</p>
        <p className="break-all font-mono text-xs">Code Assist: {window.location.origin}/gemini</p>
        <p className="text-xs text-muted-foreground">x-gemini-lb-key: Gateway API key</p>
        <Link to="/apis" className="text-primary underline">{t("nav.apis")}</Link>
      </div>
      <Link to="/legacy/accounts" className="text-xs text-muted-foreground underline">{t("gemini.accounts.legacy")}</Link>
    </div>
  );
}
