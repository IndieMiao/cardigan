import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { verifiedLocalLaunch } from "./run-resource-worker.js";

test("local startup runs only the bytes authenticated by runtime argv; credentials are data", () => {
  const base = mkdtempSync(join(tmpdir(), "private-launch-"));
  try {
    const path = join(base, "launch.sh");
    const secret = "fixture-value";
    const content = 'test "$FIXTURE" = fixture-value && printf ready';
    const launch = verifiedLocalLaunch({
      files: [{ path, content, mode: 0o700 }],
      launch_script: path,
      secret_env: { FIXTURE: secret },
    });
    expect(launch.args.join(" ")).not.toContain(secret);
    const run = () =>
      spawnSync(launch.command, launch.args, {
        cwd: base,
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 3000,
      });
    const credentials = join(base, "secrets.env");
    writeFileSync(credentials, JSON.stringify({ FIXTURE: secret }));
    writeFileSync(path, content + "\n");
    expect(run().status).toBe(125);
    writeFileSync(path, content);
    expect(run()).toMatchObject({ status: 0, stdout: "ready" });
    writeFileSync(
      credentials,
      JSON.stringify({ FIXTURE: secret, UNEXPECTED: "fixture" }),
    );
    expect(run().status).toBe(125);
  } finally {
    rmSync(base, { force: true, recursive: true });
  }
});
