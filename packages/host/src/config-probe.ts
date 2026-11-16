import { fork } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProbeAdapter, ProbeJob } from "./probe-service.js";
import { executionOwner } from "./process-identity.js";

export class ConfigProbe implements ProbeAdapter {
  constructor(
    private readonly options: {
      dataDir: string;
      entry: URL;
      releaseSha: string;
    },
  ) {}
  async advance(
    job: ProbeJob,
    checkpoint: (job: ProbeJob) => void,
    cancelled = () => job.cancel_requested === true,
  ): Promise<ProbeJob> {
    if (cancelled()) job = { ...job, cancel_requested: true };
    if (!/^[a-f0-9]{32}$/u.test(job.id))
      throw new Error("Invalid probe identity");
    const base = join(this.options.dataDir, "probe-sandboxes");
    await mkdir(base, { mode: 0o700, recursive: true });
    const parent = await lstat(base);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o7777) !== 0o700
    )
      throw new Error("Invalid sandbox root");
    const root = join(base, job.id);
    if (job.sandbox) {
      // A restarted controller never starts a second instance in the old directory.
      if (job.process) {
        const actual = executionOwner(job.process.pid);
        if (actual?.start === job.process.start) {
          // Only our exact persisted child incarnation may be stopped.
          process.kill(actual.pid, "SIGTERM");
          return { ...job, cleanup: "pending", cancel_requested: true };
        }
      }
      // Without a persisted child identity the host never sent the start message.
      // Such a child can only wait for IPC or exit; it cannot open the sandbox.
      return this.cleanup(
        {
          ...job,
          status: job.cancel_requested
            ? "cancelled"
            : job.status === "running"
              ? "failed"
              : job.status,
        },
        root,
      );
    }
    if (job.cancel_requested)
      return { ...job, status: "cancelled", cleanup: "complete" };
    // No parent environment (credentials, NODE_OPTIONS, runtime endpoints) is inherited.
    await mkdir(root, { mode: 0o700 });
    const stat = await lstat(root);
    job = {
      ...job,
      sandbox: { dev: stat.dev, ino: stat.ino },
      tested_sha: this.options.releaseSha,
    };
    checkpoint(job);
    for (const name of ["home", "config", "data", "tmp"])
      await mkdir(join(root, name), { mode: 0o700 });
    let passed = false;
    const child = fork(this.options.entry, [], {
      cwd: root,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
        XDG_CONFIG_HOME: join(root, "config"),
        CARDIGAN_CONFIG_DIR: join(root, "config"),
        CARDIGAN_DATA_DIR: join(root, "data"),
        CARDIGAN_RUNTIME_MODE: "local",
        CARDIGAN_PROBE_ROOT: root,
      },
    });
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      job.profile.timeout_ms,
    );
    const cancellation = setInterval(() => {
      if (cancelled()) {
        job = { ...job, cancel_requested: true };
        child.kill("SIGKILL");
      }
    }, 1000);
    child.on("message", (message: unknown) => {
      passed = message === "passed";
    });
    const closed = new Promise<boolean>((resolve) => {
      child.once("error", () => {
        passed = false;
      });
      child.once("close", (code) => resolve(code === 0));
    });
    try {
      const owner = child.pid && executionOwner(child.pid);
      if (!owner) throw new Error("Cannot identify probe child");
      job = { ...job, process: owner };
      checkpoint(job);
      if (cancelled()) throw new Error("Probe start cancelled");
      child.send("start", (error) => {
        if (error) child.kill("SIGKILL");
      });
      const successfulExit = await closed;
      passed &&= successfulExit;
    } catch {
      passed = false;
      child.kill("SIGKILL");
      await closed;
    } finally {
      clearTimeout(timer);
      clearInterval(cancellation);
    }
    // The installed revision must really be the requested revision; never relabel it.
    job = {
      ...job,
      ...(passed
        ? {
            checks: ["configuration", "startup", "migration", "restart"].map(
              (name) => ({ name, status: "passed" }),
            ),
          }
        : {}),
      status: cancelled()
        ? "cancelled"
        : passed && job.head_sha === this.options.releaseSha
          ? "passed"
          : "failed",
    };
    checkpoint(job);
    return this.cleanup(job, root);
  }
  private async cleanup(job: ProbeJob, root: string): Promise<ProbeJob> {
    try {
      const st = await lstat(root);
      if (
        !job.sandbox ||
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        st.uid !== process.getuid?.() ||
        st.dev !== job.sandbox.dev ||
        st.ino !== job.sandbox.ino
      )
        return { ...job, cleanup: "held" };
      await rm(root, { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        return { ...job, cleanup: "held" };
    }
    return { ...job, cleanup: "complete" };
  }
}
