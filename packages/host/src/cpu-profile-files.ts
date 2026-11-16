import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export class CpuProfileError extends Error {
  constructor(
    readonly code:
      | "unsafe"
      | "unavailable"
      | "busy"
      | "invalid_request"
      | "capacity"
      | "io"
      | "stale",
  ) {
    super(`cpu_profile_${code}`);
  }
}
const fail = () => {
  throw new CpuProfileError("unsafe");
};
const uid = () => BigInt(process.getuid?.() ?? -1);
const dirFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const same = (
  a: { dev: bigint; ino: bigint },
  b: { dev: bigint; ino: bigint },
) => a.dev === b.dev && a.ino === b.ino;
function privateFile(fd: number) {
  const s = fstatSync(fd, { bigint: true });
  if (
    !s.isFile() ||
    s.uid !== uid() ||
    (s.mode & 0o7777n) !== 0o600n ||
    s.nlink !== 1n
  )
    fail();
  return s;
}
function walk(path: string): number {
  if (process.platform !== "linux") throw new CpuProfileError("unavailable");
  let fd = openSync("/", dirFlags);
  try {
    for (const part of resolve(path).split("/").filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, dirFlags);
      closeSync(fd);
      fd = next;
      const s = fstatSync(fd, { bigint: true });
      if (
        ![0n, uid()].includes(s.uid) ||
        ((s.mode & 0o022n) !== 0n && (s.uid !== 0n || !(s.mode & 0o1000n)))
      )
        fail();
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Linux directory descriptors anchor all IO; original pathname is rechecked. */
export class CpuProfileDirectory {
  readonly fd: number;
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
    this.fd = walk(this.path);
    try {
      this.verify();
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  verify() {
    const named = walk(this.path);
    try {
      const s = fstatSync(this.fd, { bigint: true });
      if (
        !s.isDirectory() ||
        s.uid !== uid() ||
        (s.mode & 0o7777n) !== 0o700n ||
        !same(s, fstatSync(named, { bigint: true }))
      )
        fail();
    } finally {
      closeSync(named);
    }
  }
  at(name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)) fail();
    return `/proc/self/fd/${this.fd}/${name}`;
  }
  child(name: string, create: boolean) {
    this.verify();
    if (create) {
      try {
        mkdirSync(this.at(name), { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const child = new CpuProfileDirectory(join(this.path, name));
    try {
      this.verify();
      if (
        !same(
          fstatSync(child.fd, { bigint: true }),
          lstatSync(this.at(name), { bigint: true }),
        )
      )
        fail();
      return child;
    } catch (error) {
      child.close();
      throw error;
    }
  }
  read(name: string): unknown | undefined {
    this.verify();
    let fd: number;
    try {
      fd = openSync(
        this.at(name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    try {
      const before = privateFile(fd);
      // Metadata protocol only: never use this reader for profile contents.
      const buffer = Buffer.alloc(4097);
      const count = readSync(fd, buffer);
      const after = privateFile(fd);
      this.verify();
      if (
        before.size > 4096n ||
        count !== Number(before.size) ||
        !same(before, after) ||
        before.mtimeNs !== after.mtimeNs ||
        before.size !== after.size ||
        !same(after, lstatSync(this.at(name), { bigint: true }))
      )
        fail();
      return JSON.parse(buffer.subarray(0, count).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  }
  write(name: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 4096) throw new CpuProfileError("invalid_request");
    this.publish(name, bytes, true);
  }
  /** Publish complete bytes only; never overwrite a profile. */
  publish(name: string, bytes: Buffer, replace = false) {
    this.verify();
    const temporary = `partial-${randomUUID()}`;
    const path = this.at(temporary);
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    let committed = false;
    try {
      fchmodSync(fd, 0o600);
      privateFile(fd);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      this.verify();
      const s = privateFile(fd);
      if (
        s.size !== BigInt(bytes.length) ||
        !same(s, lstatSync(path, { bigint: true }))
      )
        fail();
      if (replace) {
        // Refuse hostile existing metadata, even though rename never follows it.
        this.read(name);
        renameSync(path, this.at(name));
      } else {
        // Atomic no-replace publication. A crash between link/unlink leaves
        // complete but multiply linked data: quota validation rejects it.
        linkSync(path, this.at(name));
        unlinkSync(path);
      }
      committed = true;
      privateFile(fd);
      this.verify();
      fsyncSync(this.fd);
    } finally {
      // Only our pinned, exclusive temporary inode may be removed.
      if (!committed) {
        try {
          if (
            same(
              fstatSync(fd, { bigint: true }),
              lstatSync(path, { bigint: true }),
            )
          )
            unlinkSync(path);
        } catch {
          /* Unknown or already moved: preserve for host inspection. */
        }
      }
      closeSync(fd);
    }
  }
  entries() {
    this.verify();
    return readdirSync(`/proc/self/fd/${this.fd}`);
  }
  size(name: string) {
    const fd = openSync(
      this.at(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const s = privateFile(fd);
      this.verify();
      if (!same(s, lstatSync(this.at(name), { bigint: true }))) fail();
      return Number(s.size);
    } finally {
      closeSync(fd);
    }
  }
  lock(create: boolean) {
    this.verify();
    const fd = openSync(
      this.at("owner.lock"),
      constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (create ? constants.O_CREAT : 0),
      0o600,
    );
    try {
      const initial = privateFile(fd);
      const verify = () => {
        this.verify();
        if (
          !same(initial, privateFile(fd)) ||
          !same(initial, lstatSync(this.at("owner.lock"), { bigint: true }))
        )
          fail();
      };
      const acquire = () => {
        verify();
        const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
          stdio: ["ignore", "ignore", "ignore", fd],
          env: { PATH: "/usr/bin:/bin" },
        });
        if (result.status !== 0 && result.status !== 1)
          throw new CpuProfileError("unavailable");
        verify();
        return result.status === 0;
      };
      return { acquire, verify, close: () => closeSync(fd) };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  close() {
    closeSync(this.fd);
  }
}

export function cpuProfileRoot(dataDir: string, create: boolean) {
  const parent = new CpuProfileDirectory(dataDir);
  try {
    return parent.child("cpu-profiles", create);
  } finally {
    parent.close();
  }
}

export function cpuProfileFailure(error: unknown): CpuProfileError {
  return error instanceof CpuProfileError ? error : new CpuProfileError("io");
}
