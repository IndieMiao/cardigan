/** Publish only a commit already present on the registered writer branch.
 * Never switch branches, change an index, copy untracked files or push. The
 * action id fixes the ref across retries: a later HEAD cannot overwrite it. */
export async function pinStallBackup(
  git: (args: string[]) => Promise<string>,
  assignment: string,
  action: string,
  branch: string,
) {
  if (
    !/^A-[1-9][0-9]*$/u.test(assignment) ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(action) ||
    !/^agent\/[\w.-]+\/[\w.-]+$/u.test(branch)
  )
    throw new Error("Invalid stall backup binding");
  const ref = `refs/heads/backup/stall/${assignment}/${action}`;
  const read = async (...args: string[]) => (await git(args)).trimEnd();
  const head = async () => {
    if ((await read("symbolic-ref", "-q", "HEAD")) !== `refs/heads/${branch}`)
      throw new Error("Stall backup branch changed");
    return read("rev-parse", "--verify", "HEAD^{commit}");
  };
  const sha = await head();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
    throw new Error("Invalid stall backup HEAD");
  // Create-only. On replay or an ambiguous transport result, trust only an
  // independent read of the exact ref, never a successful subprocess exit.
  try {
    await git(["update-ref", "--no-deref", ref, sha, "0".repeat(sha.length)]);
  } catch {
    /* verify below */
  }
  if (
    (await read(
      "for-each-ref",
      "--format=%(refname) %(objectname) %(symref)",
      ref,
    )) !== `${ref} ${sha}` ||
    (await read("rev-parse", "--verify", `${ref}^{commit}`)) !== sha ||
    (await head()) !== sha
  )
    throw new Error("Stall backup could not be verified");
  return { ref, sha };
}
