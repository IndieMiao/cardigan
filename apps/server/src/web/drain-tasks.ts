/** A rejected task must not release the shared store while another task still uses it. */
export async function drainTasks(tasks: Iterable<Promise<void> | undefined>) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
