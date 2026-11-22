import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RuntimeTargetBinding } from "@cardigan/domain";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import type { RuntimeWorker } from "./runtime-workers-config.js";

/** Private launch PATH only. Never retain an SSH route, opt-in or credential.
 * Substituting the saved PATH into TODAY's complete binding must reproduce
 * the launch fingerprint before the caller can use the old environment. */
export class WorkerPathHistory {
  private readonly saved = new Set<string>();
  constructor(private readonly dataDir: string) {}
  remember(binding: RuntimeTargetBinding, path: string) {
    if (this.saved.has(binding.fingerprint)) return;
    const dir = join(this.dataDir, "worker-path-history");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(join(dir, binding.fingerprint), path, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.saved.add(binding.fingerprint);
  }
  restore(worker: RuntimeWorker, binding: RuntimeTargetBinding) {
    if (
      !worker.allow_remote_launch ||
      !/^[a-f0-9]{64}$/u.test(binding.fingerprint)
    )
      return;
    try {
      const fd = openSync(
        join(this.dataDir, "worker-path-history", binding.fingerprint),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > 65536 || st.mode & 0o077) return;
        const path = readFileSync(fd, "utf8");
        const execution = { ...worker.execution, path };
        const target = runtimeTargetBinding({ ...worker, execution });
        if (target.fingerprint === binding.fingerprint)
          return { ...execution, target };
      } finally {
        closeSync(fd);
      }
    } catch {
      /* Missing or unreadable history is not authority. */
    }
  }
}
