import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SigningScope } from "@cardigan/mcp-server";

// A reviewed release helper, never a project checkout or configured shell. Its
// stdin is also the live-Run fence before the worker may use an identity.
export function requestMobileSignature(
  dataDir: string,
  scope: SigningScope,
  current: () => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      [
        "-IB",
        fileURLToPath(
          new URL("../../../deploy/mobile-signing/host.py", import.meta.url),
        ),
        join(dataDir, "mobile-signing"),
        "request",
      ],
      {
        cwd: dataDir,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 600_000,
        killSignal: "SIGKILL",
      },
    );
    let text = "",
      fenced = false;
    const fail = () => {
      child.kill("SIGKILL");
      reject(new Error("Signing unavailable"));
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 512) return fail();
      if (!fenced && text.startsWith("ready\n")) {
        try {
          current();
        } catch {
          return fail();
        }
        fenced = true;
        text = text.slice(6);
        child.stdin.end("commit\n");
      }
    });
    child.once("close", (code) => {
      const match = /^([0-9a-f]{32}) ([0-9a-f]{64})\n$/u.exec(text);
      if (code !== 0 || !fenced || !match)
        return reject(new Error("Signing unavailable"));
      resolve({
        request_id: match[1],
        sha256: match[2],
        platform: scope.platform,
      });
    });
    child.stdin.write(`${JSON.stringify(scope)}\n`);
  });
}
