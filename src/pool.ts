import { GatewayError, Store, type Account, type ClientKey } from "./store.js";

export class Pool {
  private active = new Map<string, number>();
  private selected = new Map<string, number>();
  private sequence = 0;
  constructor(readonly store: Store) {}
  inflight(id: string) {
    return this.active.get(id) ?? 0;
  }
  publicAccount(a: Account) {
    const cooldownUntil = this.store.cooldownUntil(a.quotaScope);
    const inflight = this.inflight(a.id);
    const state = !a.enabled
      ? "disabled"
      : a.state !== "ready"
        ? a.state
        : cooldownUntil > Date.now()
          ? "cooldown"
          : inflight >= a.maxInflight
            ? "saturated"
            : "ready";
    return { ...a, state, cooldownUntil, inflight };
  }
  acquire(
    key: ClientKey,
    kind: Account["kind"],
    model: string,
    excluded: Set<string>,
    pinned?: string,
  ): { account: Account; release: () => void } {
    const now = Date.now();
    let candidates = this.store
      .accounts()
      .filter(
        (a) =>
          a.kind === kind &&
          (!key.accounts.length || key.accounts.includes(a.id)),
      );
    if (pinned && !candidates.some((a) => a.id === pinned))
      throw new GatewayError(
        403,
        "Pinned account is outside this client/provider scope",
        "PERMISSION_DENIED",
      );
    const resets = candidates
      .filter(
        (a) =>
          (!pinned || a.id === pinned) &&
          a.enabled &&
          a.state === "ready" &&
          (!model || !a.models.length || a.models.includes(model)),
      )
      .map((a) => this.store.cooldownUntil(a.quotaScope, model))
      .filter((until) => until > now);
    candidates = candidates.filter(
      (a) =>
        (!pinned || a.id === pinned) &&
        !excluded.has(a.id) &&
        a.enabled &&
        a.state === "ready" &&
        (!model || !a.models.length || a.models.includes(model)) &&
        this.inflight(a.id) < a.maxInflight &&
        this.store.cooldownUntil(a.quotaScope, model) <= now &&
        !(a.quota?.buckets ?? []).some(
          (b) =>
            (!b.modelId || b.modelId === model) &&
            (b.remainingFraction === 0 || b.remainingAmount === "0") &&
            (!b.resetTime || Date.parse(b.resetTime) > now),
        ),
    );
    candidates.sort(
      (a, b) =>
        this.inflight(a.id) - this.inflight(b.id) ||
        (this.selected.get(a.id) ?? 0) - (this.selected.get(b.id) ?? 0),
    );
    const account = candidates[0];
    if (!account)
      throw new GatewayError(
        503,
        pinned
          ? "Pinned account unavailable; session will not move"
          : "No eligible accounts; check scope, model, quota and concurrency",
        "UNAVAILABLE",
        resets.length
          ? Math.max(1, Math.ceil((Math.min(...resets) - now) / 1000))
          : undefined,
      );
    this.active.set(account.id, this.inflight(account.id) + 1);
    this.selected.set(account.id, ++this.sequence);
    let released = false;
    return {
      account,
      release: () => {
        if (!released) {
          released = true;
          this.active.set(account.id, this.inflight(account.id) - 1);
        }
      },
    };
  }
  resourceReference(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value))
      return value.some((v) => this.resourceReference(v));
    return Object.entries(value).some(
      ([key, v]) =>
        ([
          "cachedContent",
          "cached_content",
          "fileData",
          "file_data",
          "thoughtSignature",
          "thought_signature",
        ].includes(key) &&
          !!v) ||
        this.resourceReference(v),
    );
  }
}
