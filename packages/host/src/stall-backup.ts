/** Pin only a commit already captured by the registered writer backup. This
 * port is bound to the host-owned bare repository; no workspace Git writes. */
export async function pinStallBackup(
  git: {
    create(ref: string, sha: string): Promise<unknown>;
    read(ref: string): Promise<string | undefined>;
    tree(sha: string): Promise<string>;
  },
  assignment: string,
  action: string,
  sha: string,
) {
  if (
    !/^A-[1-9][0-9]*$/u.test(assignment) ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(action) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha)
  )
    throw new Error("Invalid stall backup identity");
  const ref = `refs/cardigan/stall-backups/${assignment}/${action}`;
  if ((await git.read(ref)) === undefined) {
    try {
      await git.create(ref, sha);
    } catch {
      /* An ambiguous CAS needs read-back. */
    }
  }
  if (
    (await git.read(ref)) !== sha ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(await git.tree(sha))
  )
    throw new Error("Stall backup verification failed");
  return { ref, sha };
}
