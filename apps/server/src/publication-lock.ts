/**
 * C-94: one in-process lock per project around "central main moves" and
 * "that move is recorded". The pre-push check reads central main under the
 * same lock, so a merge the loop has published but not yet recorded is never
 * mistaken for a foreign commit.
 */
const tails = new Map<string, Promise<unknown>>();
export async function withPublication<T>(
  project_id: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(project_id) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => {});
  tails.set(project_id, tail);
  try {
    return await run;
  } finally {
    if (tails.get(project_id) === tail) tails.delete(project_id);
  }
}
