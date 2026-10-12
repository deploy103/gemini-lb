import { Button } from "@/components/ui/button";
import { useModelSourceQuota } from "@/features/model-sources/hooks/use-model-source-quota";

export function ModelSourceQuota({ sourceId }: { sourceId: string }) {
  const { snapshot, refresh } = useModelSourceQuota(sourceId);
  const data = snapshot.data;
  return (
    <section aria-label="Code Assist quota" className="space-y-3 rounded-md border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Code Assist quota</h3>
        <Button type="button" variant="outline" size="sm" disabled={refresh.isPending || snapshot.isFetching}
          onClick={() => refresh.mutate()}>
          {refresh.isPending ? "Refreshing quota…" : "Refresh quota"}
        </Button>
      </div>
      <p className="text-muted-foreground">Observed Google quota only. Refresh uses stored OAuth credentials, not unsaved edits.</p>
      {snapshot.isPending && <p role="status">Loading saved quota…</p>}
      {(snapshot.isError || refresh.isError) && (
        <p role="alert">Quota could not be {refresh.isError ? "refreshed" : "loaded"}. Try Refresh quota again. Any snapshot below may be outdated.</p>
      )}
      {data && <>
        <p className="text-muted-foreground">
          {data.updatedAt ? `Last observed: ${new Date(data.updatedAt).toLocaleString()}` : "Quota unknown — not yet queried."}
        </p>
        {data.buckets.length === 0 && data.updatedAt && <p>No quota buckets reported. Remaining quota is unknown.</p>}
        <ul className="space-y-2">
          {data.buckets.map((bucket, index) => (
            <li key={index} className="space-y-1 rounded border p-3 break-words">
              <p className="font-medium">{bucket.modelId ?? `Bucket ${index + 1}`}</p>
              <p>{bucket.remainingFraction === undefined ? "Remaining percentage: unknown" : `Remaining: ${Number((bucket.remainingFraction * 100).toFixed(2))}%`}</p>
              {bucket.remainingAmount !== undefined && <p>Remaining amount: {bucket.remainingAmount}</p>}
              {bucket.tokenType && <p>Token type: {bucket.tokenType}</p>}
              {bucket.resetTime && <p>Reset time: {bucket.resetTime}</p>}
            </li>
          ))}
        </ul>
      </>}
    </section>
  );
}
