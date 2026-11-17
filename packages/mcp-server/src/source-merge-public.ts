/** Internal source fingerprints may contain legacy plaintext. Redact at the
 * output boundary, including cached command replies; never alter stored proof. */
export function publicSourceMergeData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicSourceMergeData) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "source_basis")
      .map(([key, child]) => [key, publicSourceMergeData(child)]),
  ) as T;
}
