import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SigningScope } from "@cardigan/mcp-server";

export interface MobileSigningTiming {
  /** Test seam: interpreter and helper, before the private root and command. */
  readonly program?: readonly string[];
  /** How long the first call waits for a quick final answer (default 2 s). */
  readonly acceptWaitMs?: number;
  /** Until the helper reports its own size-based deadline (default 120 s). */
  readonly startupMs?: number;
  /** Backstop after the helper's reported deadline before SIGTERM (default 60 s). */
  readonly graceMs?: number;
  /** SIGTERM lets the helper record an audit action; SIGKILL after this (default 30 s). */
  readonly killMs?: number;
  /** Local hash-and-release of a stored output (default 600 s). */
  readonly permitMs?: number;
}
type Mode = "sign" | "lookup" | "stored";
interface Progress {
  accepted(request_id: string, seconds: number, mode: Mode): void;
  committed(): void;
}
const HOST = fileURLToPath(
  new URL("../../../deploy/mobile-signing/host.py", import.meta.url),
);

// The optional file descriptor is opened by the host from a fixed private directory.
// The child hashes this inode; it never receives a caller-supplied filesystem path.
function helper(
  dataDir: string,
  scope: SigningScope,
  current: () => void,
  timing: MobileSigningTiming,
  run: { artifact: { id: string; fd: number } } | { progress: Progress },
): Promise<{ request_id: string; sha256: string }> {
  const artifact = "artifact" in run ? run.artifact : undefined;
  const [file = "/usr/bin/python3", ...prefix] = timing.program ?? [
    "/usr/bin/python3",
    "-IB",
    HOST,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(
      file,
      [
        ...prefix,
        join(dataDir, "mobile-signing"),
        ...(artifact ? ["permit", artifact.id] : ["request"]),
      ],
      {
        cwd: dataDir,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        stdio: ["pipe", "pipe", "ignore", ...(artifact ? [artifact.fd] : [])],
      },
    );
    const input = child.stdin,
      output = child.stdout;
    let text = "",
      stage: "start" | "accepted" | "committed" = "start",
      accepted: string | undefined,
      receipt: { request_id: string; sha256: string } | undefined,
      failed = false,
      term: NodeJS.Timeout | undefined;
    // SIGTERM first: the helper records `interrupted` (or its own `timed_out`)
    // in the audit ledger instead of vanishing mid-request.
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), timing.killMs ?? 30_000).unref();
    };
    const arm = (ms: number) => {
      clearTimeout(term);
      term = setTimeout(stop, Math.min(ms, 2 ** 31 - 1));
      term.unref();
    };
    const fail = () => {
      if (!failed) {
        failed = true;
        input?.destroy();
        stop();
      }
      reject(new Error("Signing unavailable"));
    };
    arm(
      artifact ? (timing.permitMs ?? 600_000) : (timing.startupMs ?? 120_000),
    );
    child.once("error", fail);
    if (!input || !output) return fail();
    input.on("error", fail);
    const handle = (row: string) => {
      const start =
        /^accepted ([0-9a-f]{32}) ([1-9][0-9]{0,6}) (sign|lookup|stored)$/u.exec(
          row,
        );
      if (
        stage === "start" &&
        !artifact &&
        start?.[1] &&
        start[2] &&
        start[3]
      ) {
        stage = "accepted";
        accepted = start[1];
        arm(Number(start[2]) * 1000 + (timing.graceMs ?? 60_000));
        if ("progress" in run)
          run.progress.accepted(start[1], Number(start[2]), start[3] as Mode);
        return true;
      }
      if (
        row === "ready" &&
        (stage === "accepted" || (artifact && stage === "start"))
      ) {
        try {
          current();
        } catch {
          return false;
        }
        stage = "committed";
        input.end("commit\n");
        if ("progress" in run) run.progress.committed();
        return true;
      }
      const done = /^([0-9a-f]{32}) ([0-9a-f]{64})$/u.exec(row);
      if (stage === "committed" && !receipt && done?.[1] && done[2]) {
        receipt = { request_id: done[1], sha256: done[2] };
        return true;
      }
      return false;
    };
    output.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 512) return fail();
      for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n")) {
        const row = text.slice(0, at);
        text = text.slice(at + 1);
        if (!handle(row)) return fail();
      }
    });
    child.once("close", (code) => {
      clearTimeout(term);
      if (
        failed ||
        code !== 0 ||
        text !== "" ||
        !receipt ||
        (accepted !== undefined && receipt.request_id !== accepted) ||
        (artifact && receipt.request_id !== artifact.id)
      )
        return fail();
      resolve(receipt);
    });
    input.write(`${JSON.stringify(scope)}\n`);
  });
}

type Receipt = Awaited<ReturnType<typeof receiptFor>>;
interface Job {
  phase: "queued" | "transferring" | "signing";
  request_id: string | null;
  mode: Mode | null;
  deadline_seconds: number | null;
  readonly started: number;
  outcome?: { receipt: Receipt } | { error: true };
  readonly done: Promise<void>;
}
// One in-flight helper per Run and platform. A repeated call never starts a
// second dispatch: it reports progress, and after the job settles a fresh
// helper only performs the ledger's existing lookup for the same grant.
const jobs = new Map<string, Job>();
const RETAIN_SETTLED_MS = 3_600_000;

function receiptFor(
  scope: SigningScope,
  receipt: { request_id: string; sha256: string },
) {
  return {
    status: "signed" as const,
    ...receipt,
    platform: scope.platform,
    download: {
      method: "GET",
      query: `?mobile_artifact=${receipt.request_id}&platform=${scope.platform}`,
      requires_bearer: true,
    },
  };
}

function startJob(
  key: string,
  dataDir: string,
  scope: SigningScope,
  current: () => void,
  timing: MobileSigningTiming,
): Job {
  const job: Job = {
    phase: "queued",
    request_id: null,
    mode: null,
    deadline_seconds: null,
    started: Date.now(),
    done: helper(dataDir, scope, current, timing, {
      progress: {
        accepted: (id, seconds, mode) => {
          job.phase = "transferring";
          job.request_id = id;
          job.mode = mode;
          job.deadline_seconds = seconds;
        },
        committed: () => {
          job.phase = "signing";
        },
      },
    }).then(
      (receipt) => {
        job.outcome = { receipt: receiptFor(scope, receipt) };
      },
      () => {
        job.outcome = { error: true };
      },
    ),
  };
  void job.done.then(() => {
    setTimeout(() => {
      if (jobs.get(key) === job) jobs.delete(key);
    }, RETAIN_SETTLED_MS).unref();
  });
  return job;
}

/**
 * Accept quickly, then poll. The first call starts the helper and waits at
 * most `acceptWaitMs`; until the helper settles, every call of the same Run
 * returns `status: "pending"` with the request number and phase.
 */
export async function requestMobileSignature(
  dataDir: string,
  scope: SigningScope,
  current: () => void,
  timing: MobileSigningTiming = {},
) {
  const key = JSON.stringify([
    dataDir,
    scope.project,
    scope.machine,
    scope.card,
    scope.assignment,
    scope.run,
    scope.platform,
    scope.worker_uid,
  ]);
  let job = jobs.get(key);
  if (!job) {
    job = startJob(key, dataDir, scope, current, timing);
    jobs.set(key, job);
    await Promise.race([
      job.done,
      delay(timing.acceptWaitMs ?? 2_000, undefined, { ref: false }),
    ]);
  }
  if (job.outcome) {
    if (jobs.get(key) === job) jobs.delete(key);
    if ("error" in job.outcome) throw new Error("Signing unavailable");
    return job.outcome.receipt;
  }
  return {
    status: "pending" as const,
    request_id: job.request_id,
    platform: scope.platform,
    phase: job.phase,
    mode: job.mode,
    deadline_seconds: job.deadline_seconds,
    elapsed_seconds: Math.floor((Date.now() - job.started) / 1000),
    poll_after_seconds: 30,
  };
}

export async function openMobileArtifact(
  dataDir: string,
  scope: SigningScope,
  id: string,
  current: () => void,
  timing: MobileSigningTiming = {},
) {
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error("Signing unavailable");
  current();
  const f = await open(
    join(dataDir, "mobile-signing", "outputs", id),
    constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const size = (await f.stat()).size;
    const receipt = await helper(dataDir, scope, current, timing, {
      artifact: { id, fd: f.fd },
    });
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
