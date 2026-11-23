import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  ChainCandidate,
  ChainGrant,
  SigningScope,
} from "@cardigan/mcp-server";

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
/**
 * C-601: `continue` is a claimed request whose signer receipt is being
 * checked; it then resends the input (never committed) or looks it up.
 */
type Mode = "sign" | "continue" | "lookup" | "stored";
interface Progress {
  accepted(request_id: string, seconds: number, mode: Mode): void;
  committed(): void;
}
// Every helper process until it exits, so a server shutdown can end them
// cleanly instead of leaving orphans that wait for a commit (C-601).
const live = new Map<ChildProcess, Promise<void>>();
let draining = false;
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
  run:
    | { artifact: { id: string; fd: number } }
    | { progress: Progress }
    | { check: string },
  /** C-612: the release chain this control service attests is still approved. */
  chain?: string,
): Promise<{ request_id: string; sha256: string; handoff?: string }> {
  const artifact = "artifact" in run ? run.artifact : undefined;
  const check = "check" in run ? run.check : undefined;
  const [file = "/usr/bin/python3", ...prefix] = timing.program ?? [
    "/usr/bin/python3",
    "-IB",
    HOST,
  ];
  // Every helper is started here: none after a shutdown began (C-601).
  if (draining) return Promise.reject(new Error("Signing unavailable"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      file,
      [
        ...prefix,
        join(dataDir, "mobile-signing"),
        ...(artifact
          ? ["permit", artifact.id]
          : check
            ? ["check", check]
            : ["request"]),
      ],
      {
        cwd: dataDir,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        stdio: ["pipe", "pipe", "ignore", ...(artifact ? [artifact.fd] : [])],
      },
    );
    live.set(
      child,
      new Promise<void>((exited) =>
        child.once("close", () => {
          live.delete(child);
          exited();
        }),
      ),
    );
    const input = child.stdin,
      output = child.stdout;
    let text = "",
      // A ledger check has no fence: its only line is the result.
      stage: "start" | "accepted" | "committed" = check ? "committed" : "start",
      accepted: string | undefined,
      receipt:
        | { request_id: string; sha256: string; handoff?: string }
        | undefined,
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
        /^accepted ([0-9a-f]{32}) ([1-9][0-9]{0,6}) (sign|continue|lookup|stored)$/u.exec(
          row,
        );
      if (
        stage === "start" &&
        "progress" in run &&
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
      // C-612: an optional third field is the signer's same-machine handoff path.
      const done =
        /^([0-9a-f]{32}) ([0-9a-f]{64})(?: ((?:\/[A-Za-z0-9_.-]+)+\/[0-9a-f]{32}\.apk))?$/u.exec(
          row,
        );
      if (stage === "committed" && !receipt && done?.[1] && done[2]) {
        receipt = {
          request_id: done[1],
          sha256: done[2],
          ...(done[3]?.endsWith(`/${done[1]}.apk`) ? { handoff: done[3] } : {}),
        };
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
        (artifact && receipt.request_id !== artifact.id) ||
        (check && receipt.request_id !== check)
      )
        return fail();
      resolve(receipt);
    });
    // A download (permit) never carries the attestation; a request and a
    // ledger check do, so the host releases a chain-derived grant only while
    // its chain is still approved.
    input.write(
      `${JSON.stringify(chain && !artifact ? { ...scope, chain } : scope)}\n`,
    );
  });
}

type Receipt = ReturnType<typeof receiptFor>;
interface Job {
  phase: "queued" | "transferring" | "signing";
  /** Set once the helper has durably claimed the grant (its `accepted` line). */
  request_id: string | null;
  mode: Mode | null;
  deadline_seconds: number | null;
  readonly started: number;
  outcome?: { receipt: Receipt } | { error: true };
  readonly done: Promise<void>;
}
// One in-flight helper per Run and platform. A repeated call never starts a
// second dispatch: it reports progress. Once a claimed request has ended
// without a result, the next call runs the ledger's existing read-only lookup
// for the same request number; the ledger never dispatches a claimed grant.
const jobs = new Map<string, Job>();
const RETAIN_SETTLED_MS = 3_600_000;

function receiptFor(
  scope: SigningScope,
  {
    handoff,
    ...receipt
  }: { request_id: string; sha256: string; handoff?: string },
) {
  return {
    status: "signed" as const,
    ...receipt,
    platform: scope.platform,
    // C-612: same signed bytes, already on the signer's (= this worker's)
    // machine. Read it there and verify sha256; download otherwise.
    ...(handoff && scope.platform === "android"
      ? { local_handoff: { path: handoff, sha256: receipt.sha256 } }
      : {}),
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
  chain: string | undefined,
): Job {
  const job: Job = {
    phase: "queued",
    request_id: null,
    mode: null,
    deadline_seconds: null,
    started: Date.now(),
    done: helper(
      dataDir,
      scope,
      current,
      timing,
      {
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
      },
      chain,
    ).then(
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
  jobs.set(key, job);
  return job;
}

/**
 * Accept quickly, then poll. Each call that starts a helper waits at most
 * `acceptWaitMs`. Results:
 * - `queued`: the helper has not claimed the grant yet; no request number.
 * - `pending`: claimed under `request_id`; transfer or signing in progress.
 * - `unconfirmed`: claimed, but the attempt ended without a result; the next
 *   call continues the same request number: it resends the input if the
 *   signer never received the commit (C-601), otherwise it looks it up. The
 *   signer signs each request number at most once.
 * - `signed`: receipt re-validated against the ledger at the time of return.
 * A refusal before any claim throws.
 */
export async function requestMobileSignature(
  dataDir: string,
  scope: SigningScope,
  current: () => void,
  timing: MobileSigningTiming = {},
  /** C-612: set only while the Run's release chain is approved (see host `attested`). */
  chain?: string,
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
  const wait = (job: Job) =>
    Promise.race([
      job.done,
      delay(timing.acceptWaitMs ?? 2_000, undefined, { ref: false }),
    ]);
  let job = jobs.get(key);
  if (
    draining &&
    (!job ||
      (job.outcome && ("receipt" in job.outcome || job.request_id !== null)))
  )
    // Shutting down: never start a helper. The next server process continues
    // from the ledger under the same request number.
    return job?.request_id
      ? {
          status: "unconfirmed" as const,
          request_id: job.request_id,
          platform: scope.platform,
          poll_after_seconds: 60,
        }
      : {
          status: "queued" as const,
          request_id: null,
          platform: scope.platform,
          elapsed_seconds: 0,
          poll_after_seconds: 5,
        };
  if (!job) {
    job = startJob(key, dataDir, scope, current, timing, chain);
    await wait(job);
  } else if (job.outcome && "error" in job.outcome && job.request_id) {
    // The previous attempt ended after its claim without a result (e.g. the
    // helper was interrupted). Continue the same request: resend or look up.
    jobs.delete(key);
    job = startJob(key, dataDir, scope, current, timing, chain);
    await wait(job);
  }
  const elapsed_seconds = Math.floor((Date.now() - job.started) / 1000);
  if (job.outcome) {
    // While shutting down a settled job keeps answering with its number.
    if (
      !draining &&
      jobs.get(key) === job &&
      !("error" in job.outcome && job.request_id)
    )
      jobs.delete(key);
    if ("error" in job.outcome) {
      if (!job.request_id) throw new Error("Signing unavailable");
      return {
        status: "unconfirmed" as const,
        request_id: job.request_id,
        platform: scope.platform,
        poll_after_seconds: 60,
      };
    }
    // A remembered success is only reported while the ledger still releases
    // it. Shutting down: no check now; the next process looks it up again.
    const receipt = job.outcome.receipt;
    if (draining)
      return {
        status: "unconfirmed" as const,
        request_id: receipt.request_id,
        platform: scope.platform,
        poll_after_seconds: 60,
      };
    const now = await helper(
      dataDir,
      scope,
      current,
      timing,
      { check: receipt.request_id },
      chain,
    );
    if (now.sha256 !== receipt.sha256) throw new Error("Signing unavailable");
    return receipt;
  }
  if (!job.request_id)
    return {
      status: "queued" as const,
      request_id: null,
      platform: scope.platform,
      elapsed_seconds,
      poll_after_seconds: 5,
    };
  return {
    status: "pending" as const,
    request_id: job.request_id,
    platform: scope.platform,
    phase: job.phase,
    mode: job.mode,
    deadline_seconds: job.deadline_seconds,
    elapsed_seconds,
    poll_after_seconds: 30,
  };
}

/**
 * Server shutdown (C-601): start no further helper, give the running ones up
 * to `waitMs` to finish, then SIGTERM them so each records `interrupted` and
 * closes its signer connection; SIGKILL after `killMs`. A claimed request
 * left before its commit is resent by the next process; one already
 * committed is looked up. Resolves once every helper has exited or the
 * SIGKILL was sent. Final for the process: it is about to exit.
 */
export async function drainMobileSigning(options: {
  readonly waitMs: number;
  readonly killMs: number;
}): Promise<void> {
  draining = true;
  const exited = (ms: number) =>
    Promise.race([
      Promise.all(live.values()),
      delay(Math.max(0, ms), undefined, { ref: false }),
    ]);
  if (live.size) await exited(options.waitMs);
  for (const child of live.keys()) child.kill("SIGTERM");
  if (live.size) await exited(options.killMs);
  for (const child of live.keys()) child.kill("SIGKILL");
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

/**
 * C-612: register and approve this Run's release-chain candidate through
 * `host.py chain`. The candidate bytes go to the helper on fd 3; the host
 * verifies the digest, fixes app and credential version from its route, and
 * reports `new`, `existing` (this chain's candidate already holds the Run's
 * grant) or `other`. Bounded by `permitMs`; never started while draining.
 */
export async function registerChainCandidate(
  dataDir: string,
  scope: SigningScope,
  candidate: ChainCandidate,
  current: () => void,
  timing: MobileSigningTiming = {},
): Promise<ChainGrant> {
  if (draining) throw new Error("Signing unavailable");
  current();
  const source = await candidate.source();
  const [file = "/usr/bin/python3", ...prefix] = timing.program ?? [
    "/usr/bin/python3",
    "-IB",
    HOST,
  ];
  const child = spawn(
    file,
    [...prefix, join(dataDir, "mobile-signing"), "chain"],
    {
      cwd: dataDir,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    },
  );
  live.set(
    child,
    new Promise<void>((exited) =>
      child.once("close", () => {
        live.delete(child);
        exited();
      }),
    ),
  );
  // The host skips fd 3 for an existing grant; a reset pipe is not an error.
  const ignore = () => {};
  child.stdin?.on("error", ignore);
  child.stdio[3]?.on("error", ignore);
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), timing.killMs ?? 30_000).unref();
  }, timing.permitMs ?? 600_000);
  timer.unref();
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let text = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 128) child.kill("SIGKILL");
    });
    child.stdin?.end(
      `${JSON.stringify(scope)}\n${JSON.stringify({
        commit: candidate.commit,
        build: candidate.build,
        sha256: candidate.sha256,
        size: candidate.size,
        decision: candidate.decision,
      })}\n`,
    );
    const input = child.stdio[3];
    if (!input || !("write" in input)) throw new Error("Signing unavailable");

    // A refusal may close fd 3 early; the exit code decides.
    await pipeline(source, input).catch(() => undefined);
    const code = await closed;
    const m = /^([0-9a-f]{32}) (new|existing|other)\n$/u.exec(text);
    if (code !== 0 || !m?.[1] || !m[2]) throw new Error("Signing unavailable");
    return { request_id: m[1], status: m[2] as ChainGrant["status"] };
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
}
