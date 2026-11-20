import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SigningScope } from "@cardigan/mcp-server";

// The optional file descriptor is opened by the host from a fixed private directory.
// The child hashes this inode; it never receives a caller-supplied filesystem path.
function helper(
  dataDir: string,
  scope: SigningScope,
  current: () => void,
  artifact?: { id: string; fd: number },
): Promise<{ request_id: string; sha256: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      [
        "-IB",
        fileURLToPath(
          new URL("../../../deploy/mobile-signing/host.py", import.meta.url),
        ),
        join(dataDir, "mobile-signing"),
        ...(artifact ? ["permit", artifact.id] : ["request"]),
      ],
      {
        cwd: dataDir,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        stdio: ["pipe", "pipe", "ignore", ...(artifact ? [artifact.fd] : [])],
        timeout: 600_000,
        killSignal: "SIGKILL",
      },
    );
    const input = child.stdin,
      output = child.stdout;
    let text = "",
      fenced = false;
    const fail = () => {
      child.kill("SIGKILL");
      reject(new Error("Signing unavailable"));
    };
    child.once("error", fail);
    if (!input || !output) return fail();
    input.on("error", fail);
    output.setEncoding("utf8").on("data", (chunk: string) => {
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
        input.end("commit\n");
      }
    });
    child.once("close", (code) => {
      const match = /^([0-9a-f]{32}) ([0-9a-f]{64})\n$/u.exec(text);
      if (
        code !== 0 ||
        !fenced ||
        !match?.[1] ||
        !match[2] ||
        (artifact && match[1] !== artifact.id)
      )
        return reject(new Error("Signing unavailable"));
      resolve({ request_id: match[1], sha256: match[2] });
    });
    input.write(`${JSON.stringify(scope)}\n`);
  });
}
export async function requestMobileSignature(
  dataDir: string,
  scope: SigningScope,
  current: () => void,
) {
  const receipt = await helper(dataDir, scope, current);
  return {
    ...receipt,
    platform: scope.platform,
    download: {
      method: "GET",
      query: `?mobile_artifact=${receipt.request_id}&platform=${scope.platform}`,
      requires_bearer: true,
    },
  };
}
export async function openMobileArtifact(
  dataDir: string,
  scope: SigningScope,
  id: string,
  current: () => void,
) {
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error("Signing unavailable");
  current();
  const f = await open(
    join(dataDir, "mobile-signing", "outputs", id),
    constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const size = (await f.stat()).size;
    const receipt = await helper(dataDir, scope, current, { id, fd: f.fd });
    current();
    return {
      size,
      sha256: receipt.sha256,
      stream: f.createReadStream({ start: 0, autoClose: true }),
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
