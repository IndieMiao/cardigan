import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import {
  onboardingFail,
  type WorkerOnboardingConfig,
  WorkerOnboardingError,
} from "./worker-onboarding-config.js";

/**
 * C-706: the one-time initialisation script for a device paired into the
 * add-worker wizard. The script's actions are fixed in `deploy/device-init.py`;
 * only this validated plan and the bundled installer files are embedded, both
 * as base64 JSON, so no plan value can add code or widen what it touches.
 */
export interface DeviceInitPlan {
  readonly version: 1;
  readonly os: "linux" | "darwin";
  readonly project: string;
  readonly account: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly work: string;
  /** `restrict ssh-ed25519 <key>`; the comment of the host's key is dropped. */
  readonly public_key: string;
}

const INSTALLERS = [
  "install-macos-worker.py",
  "install-linux-worker.py",
  "worker-primitives.py",
] as const;
const deploy = (name: string) =>
  new URL(`../../../deploy/${name}`, import.meta.url);
// A release is immutable for the lifetime of the controller process.
let release: { template: string; files: string } | undefined;
function bundle() {
  release ??= {
    template: readFileSync(deploy("device-init.py"), "utf8"),
    files: Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          INSTALLERS.map((name) => [
            name,
            readFileSync(deploy(name)).toString("base64"),
          ]),
        ),
      ),
    ).toString("base64"),
  };
  return release;
}

const PROJECT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u;
const ACCOUNT = /^cg_[a-z0-9_]{1,26}$/u;
const KEY = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [^\n]*)?\n?$/u;
const KEY_BLOB = Buffer.from("\0\0\0\x0bssh-ed25519\0\0\0\x20", "latin1");
const HOME_PARENT = { linux: "/home", darwin: "/Users" } as const;
const WORK_PARENTS = {
  linux: ["/srv/cardigan-workers", "/home/cardigan-workers"],
  darwin: ["/Users/cardigan-workers"],
} as const;

/**
 * The control host's SSH public key from `<config>/worker-key.pub`, as an
 * `authorized_keys` line with `restrict`. Only an Ed25519 key in a regular
 * file of this user is accepted; nothing about the file is echoed.
 */
export function workerPublicKey(configRoot: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(configRoot, "worker-key.pub"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || s.size > 4096)
      return onboardingFail("worker_public_key_invalid");
    const buffer = Buffer.alloc(4097);
    const text = buffer.subarray(0, readSync(fd, buffer)).toString("utf8");
    const blob = KEY.exec(text)?.[1];
    if (
      !blob ||
      !Buffer.from(blob, "base64").subarray(0, KEY_BLOB.length).equals(KEY_BLOB)
    )
      return onboardingFail("worker_public_key_invalid");
    return `restrict ssh-ed25519 ${blob}`;
  } catch (e) {
    if (e instanceof WorkerOnboardingError) throw e;
    return onboardingFail("worker_public_key_invalid");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The plan for a confirmed wizard configuration; refuses anything outside the fixed layout. */
export function deviceInitPlan(
  config: Pick<WorkerOnboardingConfig, "uid" | "home" | "worker">,
  publicKey: string,
): DeviceInitPlan {
  const { worker } = config,
    e = worker.execution;
  const os = worker.os === "darwin" ? "darwin" : "linux";
  const project = worker.project_id,
    account = e.user ?? "",
    gid = e.gid ?? -1,
    work = e.agentRoot;
  if (
    (worker.os !== "darwin" && worker.os !== "linux") ||
    !PROJECT.test(project) ||
    !ACCOUNT.test(account) ||
    ![config.uid, gid].every(
      (v) => Number.isSafeInteger(v) && v >= 501 && v <= 2147483647,
    ) ||
    config.home !== `${HOME_PARENT[os]}/${account}` ||
    !(WORK_PARENTS[os] as readonly string[]).some(
      (parent) => work === `${parent}/${project}`,
    ) ||
    !/^restrict ssh-ed25519 [A-Za-z0-9+/]{68}$/u.test(publicKey)
  )
    return onboardingFail("device_init_unsupported");
  return {
    version: 1,
    os,
    project,
    account,
    uid: config.uid,
    gid,
    home: config.home,
    work,
    public_key: publicKey,
  };
}

/** The complete script: the fixed template with the plan and installer files filled in. */
export function deviceInitScript(plan: DeviceInitPlan): string {
  const { template, files } = bundle();
  const literal = (b64: string) =>
    `json.loads(base64.b64decode("${b64}").decode("utf-8"))`;
  const encoded = Buffer.from(JSON.stringify(plan)).toString("base64");
  const lines = template.split("\n");
  const fill = (marker: string, value: string) => {
    const index = lines.indexOf(`${marker} = None  # @${marker.toLowerCase()}`);
    if (index < 0) throw new Error("device-init template marker missing");
    lines[index] = `${marker} = ${value}`;
  };
  fill("PLAN", literal(encoded));
  fill("FILES", literal(files));
  return lines.join("\n");
}
