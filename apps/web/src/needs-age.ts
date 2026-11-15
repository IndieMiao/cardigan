/** Copy display ages at the server's validated current time, never mutate cache. */
export function needsAges<T>(page: T, sampledAt: string, currentAt: string): T {
  const elapsed = Math.max(0, Date.parse(currentAt) - Date.parse(sampledAt));
  if (!Number.isFinite(elapsed) || elapsed === 0) return page;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === "number" && key === "waited_ms"
          ? item + elapsed
          : typeof item === "number" && key === "remaining_ms"
            ? Math.max(0, item - elapsed)
            : visit(item),
      ]),
    );
  };
  return visit(page) as T;
}
