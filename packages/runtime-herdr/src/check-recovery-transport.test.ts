import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentExecution } from "./agent-files.js";
import {
  type CheckRecoveryBinding,
  recoverCheckDirectory,
} from "./check-recovery.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const binding: CheckRecoveryBinding = {
  git_layout: "bare",
  registration_name: "worktree",
  container: { device: "1", inode: "11", uid: 1234 },
  worktree: { device: "1", inode: "12", uid: 1234 },
  repository: { device: "1", inode: "13", uid: 1234 },
  registration: { device: "1", inode: "14", uid: 1234 },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recovery-transport-"));
  roots.push(root);
  const identityFile = join(root, "fixture-key"),
    knownHostsFile = join(root, "fixture-hosts");
  await writeFile(identityFile, "synthetic", { mode: 0o600 });
  await writeFile(knownHostsFile, "synthetic", { mode: 0o600 });
  const execution: AgentExecution = {
    mode: "agent-ssh",
    dataDir: root,
    agentRoot: "/executor",
    machine: "fixture",
    gid: 1234,
    identityFile,
    knownHostsFile,
    host: "fixture.invalid",
    user: "agent",
    hostKeyAlias: "fixture",
  };
  return {
    execution,
    input: {
      project: "p",
      attempt: "attempt",
      sha: "a".repeat(40),
      binding,
      slots: 1,
      confirmAbsence: vi.fn(),
    },
  };
}
const fakeRemote = (behavior: string) => `
const {createInterface}=require('node:readline'),{createHmac}=require('node:crypto');
const lines=createInterface({input:process.stdin});
lines.once('line',line=>{
 const request=JSON.parse(line);
 const send=value=>process.stdout.write(JSON.stringify({...value,auth:createHmac('sha256',request.auth_key).update(JSON.stringify(value)).digest('hex')})+'\\n');
 const result={status:'cleaned',reason:'complete',processes:[]};
 ${behavior}
});`;

test("fixed pinned SSH protocol audits absence without a deletion acknowledgement", async () => {
  const f = await fixture();
  const result = await recoverCheckDirectory(
    f.execution,
    f.input,
    (file, args, env) => {
      expect(file).toBe("ssh");
      expect(args).toEqual(
        expect.arrayContaining([
          "StrictHostKeyChecking=yes",
          "HostKeyAlias=fixture",
          "agent@fixture.invalid",
        ]),
      );
      expect(args.at(-1)).toContain("'/usr/bin/python3' '-I'");
      expect(env).toEqual({ PATH: "/usr/bin:/bin" });
      return spawn(
        process.execPath,
        [
          "-e",
          fakeRemote(
            "send({phase:'absent'}); lines.once('line',value=>{if(value==='confirm')send(result);lines.close();});",
          ),
        ],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
    },
  );
  expect(f.input.confirmAbsence).toHaveBeenCalledOnce();
  expect(result).toEqual({
    status: "cleaned",
    reason: "complete",
    processes: [],
  });
});

test.each([
  "send({phase:'ready'});lines.close();",
  "send({status:'manual_attention',reason:'unverified',stage:'private-secret',processes:[]});lines.close();",
  "send({status:'manual_attention',reason:'unverified',evidence:'private-secret',processes:[]});lines.close();",
  "send(result);lines.close();",
  "process.stdout.write(JSON.stringify(result)+'\\n');lines.close();",
  "send({status:'manual_attention',reason:'occupied',processes:[{pid:1,state:'D',wchan:'private data'}]});lines.close();",
  "send({status:'manual_attention',reason:'unverified',processes:[]});send(result);lines.close();",
])(
  "rejects forged, premature, duplicated or unsanitized evidence: %s",
  async (behavior) => {
    const f = await fixture();
    const result = await recoverCheckDirectory(f.execution, f.input, () =>
      spawn(process.execPath, ["-e", fakeRemote(behavior)], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(result).toEqual({
      status: "manual_attention",
      reason: "transport",
      stage: "transport",
      processes: [],
    });
    expect(f.input.confirmAbsence).not.toHaveBeenCalled();
  },
);

test("an exclusion failure is reported without requesting any confirmation", async () => {
  const f = await fixture();
  const result = await recoverCheckDirectory(f.execution, f.input, () =>
    spawn(
      process.execPath,
      [
        "-e",
        fakeRemote(
          "send({status:'manual_attention',reason:'exclusion_unproven',processes:[]});lines.close();",
        ),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  expect(result).toEqual({
    status: "manual_attention",
    reason: "exclusion_unproven",
    processes: [],
  });
  expect(f.input.confirmAbsence).not.toHaveBeenCalled();
});

test("an audit failure prevents absence confirmation", async () => {
  const f = await fixture();
  f.input.confirmAbsence.mockImplementation(() => {
    throw new Error("fixture store failure");
  });
  const result = await recoverCheckDirectory(f.execution, f.input, () =>
    spawn(
      process.execPath,
      [
        "-e",
        fakeRemote(
          "send({phase:'absent'}); lines.once('line',()=>{send(result);lines.close();});",
        ),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  expect(result.status).toBe("manual_attention");
});

test.each(["../other", "attempt/other", "-option", "attempt;touch file"])(
  "refuses arbitrary attempt input %s before starting SSH",
  async (attempt) => {
    const f = await fixture(),
      start = vi.fn();
    await expect(
      recoverCheckDirectory(f.execution, { ...f.input, attempt }, start),
    ).rejects.toThrow("Invalid check recovery identity");
    expect(start).not.toHaveBeenCalled();
  },
);
