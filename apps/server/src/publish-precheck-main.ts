import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatPrecheck, publicationPrecheck } from "./publish-precheck.js";

const hashFile = (path: string) =>
  new Promise<string>((done, failed) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (b) => hash.update(b))
      .on("error", failed)
      .on("end", () => done(hash.digest("hex")));
  });

// A separate executable: importing server/index/bin would start unrelated loops.
// Run as the control service user, which owns ~/.config/cardigan.
const [project, apk, version, ...extra] = process.argv.slice(2);
if (
  project === undefined ||
  extra.length > 0 ||
  (apk !== undefined && version === undefined) ||
  !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(project)
) {
  process.stderr.write(
    "Use <project-id> [<apk-file> <version>]. Read-only: checks publish-targets.json, apksigner, apkanalyzer, ossutil, credentials, GetBucketVersioning and prefix ListObjects; with an APK also its signature, package name, version-name and that its release directory is empty. Writes no OSS objects and no cards.\n",
  );
  process.exitCode = 2;
} else {
  const file = apk === undefined ? undefined : resolve(apk);
  const sha256 = file ? await hashFile(file).catch(() => undefined) : undefined;
  if (file && sha256 === undefined) {
    process.stderr.write("Cannot read the APK file.\n");
    process.exitCode = 2;
  } else {
    const results = await publicationPrecheck(project, undefined, undefined, {
      ...(file && sha256 && version
        ? {
            artifact: {
              sha256,
              version,
              stage: async (dest: string) => {
                await copyFile(file, dest);
                // The staged copy must still be the bytes that were hashed.
                if ((await hashFile(dest)) !== sha256) throw Error();
              },
            },
          }
        : {}),
    });
    process.stdout.write(`${formatPrecheck(results)}\n`);
    process.exitCode = results.every((r) => r.ok === true) ? 0 : 1;
  }
}
