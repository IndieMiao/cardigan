import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeFailure } from "./runtime-failure.js";

const helper = `
import fcntl,json,os,stat,sys
def safe():
    info=os.fstat(3)
    return stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1
if not safe(): sys.exit(1)
print(json.dumps(dict(id=0,status='ready')),flush=True)
for line in sys.stdin:
    try:
        request=json.loads(line)
        seq=request['id']
        if type(seq) is not int or seq<=0 or not safe(): sys.exit(1)
        if request['op']=='try':
            try:
                fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)
                status='acquired'
            except BlockingIOError: status='busy'
        elif request['op']=='unlock':
            fcntl.flock(3,fcntl.LOCK_UN)
            status='released'
        else: sys.exit(1)
        print(json.dumps(dict(id=seq,status=status)),flush=True)
    except Exception: sys.exit(1)
`;
const unavailable = () =>
  new RuntimeFailure("runtime_unavailable", "hc queue helper unavailable");
const expired = () =>
  new RuntimeFailure("runtime_queue_timeout", "hc 调用排队超时，尚未执行命令");
const safe = (info: BigIntStats) =>
  info.isFile() &&
  info.uid === BigInt(process.getuid?.() ?? -1) &&
  (info.mode & 0o777n) === 0o600n &&
  info.nlink === 1n;
type Refable = { ref?(): unknown; unref?(): unknown };
type Pending = {
  id: number;
  op: "ready" | "try" | "unlock";
  resolve(status: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

/** One private pipe and shared open file description per used global slot.
 * The controller retains the fd: helper death cannot unlock an active call.
 */
class Slot {
  readonly ready: Promise<void>;
  private fd: FileHandle | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private closed = false;
  private ended: Promise<void> = Promise.resolve();
  private broken: Error | undefined;
  private pending: Pending | undefined;
  private buffer = "";
  private sequence = 0;
  private claimed = false;
  private owned = false;
  private forceRef = false;
  private cleanup: Promise<void> | undefined;
  constructor(
    readonly path: string,
    deadline: number,
    private gone: () => void,
  ) {
    this.ready = this.initialize(deadline).catch((error) => {
      this.fail(error instanceof RuntimeFailure ? error : unavailable());
      throw this.broken;
    });
  }
  private refs() {
    const mode =
      this.forceRef || this.claimed || this.owned || this.pending
        ? "ref"
        : "unref";
    this.child?.[mode]();
    (this.child?.stdin as Refable | undefined)?.[mode]?.();
    (this.child?.stdout as Refable | undefined)?.[mode]?.();
  }
  private async initialize(deadline: number) {
    this.fd = await open(
      this.path,
      constants.O_CREAT |
        constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    if (!safe(await this.fd.stat({ bigint: true }))) throw unavailable();
    const child = spawn("python3", ["-B", "-u", "-c", helper], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "ignore", this.fd.fd],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.ended = new Promise<void>((resolve) =>
      child.once("close", () => {
        this.closed = true;
        this.fail(unavailable());
        resolve();
      }),
    );
    child.once("error", () => this.fail(unavailable()));
    child.stdin.on("error", () => this.fail(unavailable()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    await this.wait(0, "ready", deadline, expired);
  }
  private wait(
    id: number,
    op: Pending["op"],
    deadline: number,
    failure: () => RuntimeFailure,
  ): Promise<string> {
    if (this.broken) return Promise.reject(this.broken);
    if (this.pending) return Promise.reject(unavailable());
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      this.fail(failure());
      return Promise.reject(this.broken);
    }
    return new Promise((resolve, reject) => {
      this.pending = {
        id,
        op,
        resolve,
        reject,
        timer: setTimeout(() => this.fail(failure()), remaining),
      };
      this.refs();
    });
  }
  private command(op: "try" | "unlock", deadline: number) {
    const id = ++this.sequence;
    const reply = this.wait(
      id,
      op,
      deadline,
      op === "try" ? expired : unavailable,
    );
    if (this.pending && !this.broken)
      this.child?.stdin.write(`${JSON.stringify({ id, op })}\n`);
    return reply;
  }
  private read(chunk: string) {
    if (this.broken) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
      this.fail(unavailable());
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const message = JSON.parse(line) as {
          id?: unknown;
          status?: unknown;
        } | null;
        const pending = this.pending;
        const statuses =
          pending?.op === "ready"
            ? ["ready"]
            : pending?.op === "try"
              ? ["acquired", "busy"]
              : ["released"];
        if (
          !pending ||
          message?.id !== pending.id ||
          typeof message.status !== "string" ||
          !statuses.includes(message.status)
        )
          throw unavailable();
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (message.status === "acquired") this.owned = true;
        if (message.status === "released") this.owned = false;
        this.refs();
        pending.resolve(message.status);
      } catch {
        this.fail(unavailable());
        return;
      }
    }
  }
  private fail(error: Error) {
    if (!this.broken) {
      this.broken = error;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      if (!this.closed) this.child?.kill("SIGKILL");
    }
    this.refs();
    void this.clean();
  }
  private clean() {
    if (
      !this.cleanup &&
      this.broken &&
      !this.claimed &&
      !this.owned &&
      (!this.child || this.closed)
    ) {
      this.cleanup = (async () => {
        await this.fd?.close();
        this.gone();
      })();
      // Unknown close failure keeps the broken slot fenced until process exit.
      void this.cleanup.catch(() => {});
    }
    return this.cleanup;
  }
  private async validate() {
    const fresh = await open(
      this.path,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const a = await fresh.stat({ bigint: true }),
        b = await this.fd?.stat({ bigint: true });
      if (!b || !safe(a) || !safe(b) || a.dev !== b.dev || a.ino !== b.ino)
        throw unavailable();
    } finally {
      await fresh.close();
    }
  }
  async acquire(
    waitMs: number,
    deadline: number,
    releaseBudgetMs: number,
  ): Promise<(() => Promise<void>) | undefined> {
    await this.ready;
    const end = Math.min(deadline, performance.now() + waitMs);
    let retryMs = 1;
    // A shared OFD would reenter its own flock. Reserve it locally as well.
    while (this.claimed) {
      if (this.broken) throw this.broken;
      const left = end - performance.now();
      if (left <= 0) return undefined;
      await delay(Math.min(retryMs, left));
      retryMs = Math.min(100, retryMs * 2);
    }
    if (this.broken) throw this.broken;
    this.claimed = true;
    this.refs();
    let granted = false;
    try {
      await this.validate();
      for (;;) {
        const status = await this.command("try", deadline);
        if (this.broken) throw this.broken;
        if (status === "acquired") {
          granted = true;
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            try {
              if (!this.broken)
                await this.command(
                  "unlock",
                  performance.now() + releaseBudgetMs,
                );
            } finally {
              this.owned = false;
              this.claimed = false;
              this.refs();
              await this.clean();
            }
          };
        }
        const left = end - performance.now();
        if (left <= 0) return undefined;
        await delay(Math.min(retryMs, left));
        retryMs = Math.min(100, retryMs * 2);
      }
    } catch (error) {
      this.fail(error instanceof RuntimeFailure ? error : unavailable());
      throw this.broken;
    } finally {
      if (!granted) {
        this.owned = false;
        this.claimed = false;
        this.refs();
        await this.clean();
      }
    }
  }
  async closeIdle() {
    await this.ready.catch(() => {});
    if (this.claimed || this.owned || this.pending) return;
    this.forceRef = true;
    this.fail(unavailable());
    this.refs();
    await this.ended;
    await this.clean();
    this.forceRef = false;
    this.refs();
  }
}

const slots = new Map<string, Slot>();
let exitHook = false;
/** Internal lifecycle helper; active calls retain their descriptors. */
export async function closeIdleHcLockHelpers() {
  await Promise.all([...slots.values()].map((slot) => slot.closeIdle()));
}
export async function acquireHcFileSlot(
  path: string,
  waitMs: number,
  deadline: number,
  releaseBudgetMs: number,
) {
  let slot = slots.get(path);
  if (!slot) {
    const created = new Slot(path, deadline, () => {
      if (slots.get(path) === created) slots.delete(path);
    });
    slot = created;
    slots.set(path, slot);
    if (!exitHook) {
      exitHook = true;
      process.once("beforeExit", () => {
        exitHook = false;
        void closeIdleHcLockHelpers().catch(() => {});
      });
    }
  }
  return slot.acquire(waitMs, deadline, releaseBudgetMs);
}
