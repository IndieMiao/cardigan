import { formatPrecheck, publicationPrecheck } from "./publish-precheck.js";

// A separate executable: importing server/index/bin would start unrelated loops.
// Run as the control service user, which owns ~/.config/cardigan.
const [project, ...extra] = process.argv.slice(2);
if (
  project === undefined ||
  extra.length > 0 ||
  !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(project)
) {
  process.stderr.write(
    "Use <project-id>. Read-only: checks publish-targets.json, apksigner, apkanalyzer, ossutil, credentials, GetBucketVersioning and prefix ListObjects. Writes no OSS objects and no cards.\n",
  );
  process.exitCode = 2;
} else {
  const results = await publicationPrecheck(project);
  process.stdout.write(`${formatPrecheck(results)}\n`);
  process.exitCode = results.every((r) => r.ok === true) ? 0 : 1;
}
