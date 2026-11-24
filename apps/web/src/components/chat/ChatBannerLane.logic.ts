export type ChatBannerSeverity = "error" | "warning" | "other";

export interface ChatBannerOrderInput {
  readonly id: string;
  readonly severity: ChatBannerSeverity;
  /** Monotonic first-appearance sequence; a larger value is the newer banner. */
  readonly appearedAt: number;
}

export interface ChatBannerAppearance {
  readonly order: ReadonlyMap<string, number>;
  readonly next: number;
}

const SEVERITY_RANK: Record<ChatBannerSeverity, number> = {
  error: 0,
  warning: 1,
  other: 2,
};

/** Errors first, then warnings, then the rest; within a severity the newest banner leads. */
export function orderChatBannerItems<T extends ChatBannerOrderInput>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity] ||
        b.item.appearedAt - a.item.appearedAt ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

/** Collapsed shows only the highest-priority strip; expanded lists every one. */
export function visibleChatBannerItems<T>(
  ordered: readonly T[],
  expanded: boolean,
): { readonly visible: readonly T[]; readonly hiddenCount: number } {
  const visible = expanded ? ordered : ordered.slice(0, 1);
  return { visible, hiddenCount: ordered.length - visible.length };
}

export function createChatBannerAppearance(ids: readonly string[]): ChatBannerAppearance {
  return registerChatBannerAppearance({ order: new Map(), next: 0 }, ids);
}

/** Assigns a sequence to ids seen for the first time; returns the same state when none are new. */
export function registerChatBannerAppearance(
  previous: ChatBannerAppearance,
  ids: readonly string[],
): ChatBannerAppearance {
  const missing = ids.filter((id) => !previous.order.has(id));
  if (missing.length === 0) return previous;
  const order = new Map(previous.order);
  let next = previous.next;
  for (const id of missing) {
    order.set(id, next);
    next += 1;
  }
  return { order, next };
}
