import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getModelSourceQuota, refreshModelSourceQuota } from "@/features/model-sources/api";

export function useModelSourceQuota(sourceId: string) {
  const queryClient = useQueryClient();
  const queryKey = ["model-sources", sourceId, "quota"];
  const snapshot = useQuery({
    queryKey,
    queryFn: () => getModelSourceQuota(sourceId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const refresh = useMutation({
    mutationFn: () => refreshModelSourceQuota(sourceId),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  return { snapshot, refresh };
}
