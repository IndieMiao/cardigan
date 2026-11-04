import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const branch = "refs/heads/agent/C-1/W-1";
const delivery = "refs/cardigan/deliveries/D-1";
const backup = "refs/cardigan/backups/worker-a/agent/C-1/W-1";
const identity = ["-c", "user.name=Cardigan Spike", "-c", "user.email=spike@example.invalid",
  "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper="];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|SSH_)/.test(key)));
Object.assign(env, { LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
const sshArgs = ["-F", "/dev/null", "-4", "-i", join(homedir(), ".ssh/cardigan_spike_ed25519"),
  "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
  "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
  "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "ControlMaster=no", "-o", "ControlPath=none"];

async function command(file, args, extraEnv = {}) {
  const started = performance.now();
  try {
    const result = await exec(file, args, { env: { ...env, ...extraEnv }, timeout: 15000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim(), ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout?.trim() ?? "", stderr: error.stderr?.trim() ?? "",
      ms: Math.round(performance.now() - started), killed: error.killed };
  }
}

function checked(result) {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

// One run owns all paths it removes. No user repositories, SSH config or account mutations.
export async function runScenario(mode, log = console.log) {
  assert.ok(["local", "ssh"].includes(mode), "mode must be local or ssh");
  const root = await mkdtemp(join(tmpdir(), "cardigan-p0-git-"));
  let workerRoot;
  const central = join(root, "central.git");
  const integration = join(root, "integration");
  const ssh = (script) => command("ssh", [...sshArgs, "cardigan-agent@localhost", script]);
  const gitResult = (cwd, args, extraEnv) => command("git", [...identity, "-C", cwd, ...args], extraEnv);
  const git = async (cwd, ...args) => checked(await gitResult(cwd, args));
  const event = (name, data = {}) => log(JSON.stringify({ mode, event: name, ...data }));
  const sshCommand = ["ssh", ...sshArgs].map(quote).join(" ");
  const transportEnv = mode === "ssh" ? { GIT_SSH_COMMAND: sshCommand, GIT_SSH_VARIANT: "ssh" } : {};
  const fetch = (source, refspec, extraEnv = {}) => gitResult(central,
    ["fetch", "--no-tags", "--no-write-fetch-head", source, refspec], { ...transportEnv, ...extraEnv });
  try {
    event("versions", { node: process.version, git: await git(root, "--version") });
    if (mode === "ssh") {
      // Check filenames only. Never read keys or credential contents, or forward the host's agent.
      checked(await ssh('test -z "${SSH_AUTH_SOCK:-}" && test -z "$(git config --get-all credential.helper)" && test ! -e "$HOME/.git-credentials" && test ! -e "$HOME/.config/git/credentials" && test ! -e "$HOME/.netrc" && test ! -e "$HOME/.config/gh/hosts.yml" && test ! -e "$HOME/.config/glab-cli/config.yml" && test -f "$HOME/.ssh/authorized_keys" && test "$(ls -A "$HOME/.ssh")" = authorized_keys'));
      workerRoot = checked(await ssh("mktemp -d /tmp/cardigan-p0-git-worker-XXXXXXXX"));
      assert.match(workerRoot, /^\/tmp\/cardigan-p0-git-worker-[A-Za-z0-9]+$/);
      event("worker-preflight", { git: checked(await ssh("git --version")), privateKeys: false, forwardedAgent: false, credentialFiles: false });
    } else {
      workerRoot = join(root, "worker");
      await mkdir(workerRoot);
    }
    const workerRepo = join(workerRoot, "repo");
    const worktree = join(workerRoot, "worktree");
    const workerCommand = async (file, args) => mode === "ssh"
      ? checked(await ssh(["env", "-i", "PATH=/usr/bin:/bin", "LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1",
        "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", file, ...args].map(quote).join(" ")))
      : checked(await command(file, args));
    const workerGit = (cwd, ...args) => workerCommand("git", [...identity, "-C", cwd, ...args]);
    const workerWrite = async (path, text) => mode === "ssh"
      ? checked(await ssh(`printf '%s' ${quote(text)} > ${quote(path)}`))
      : writeFile(path, text);
    const source = mode === "ssh" ? `ssh://cardigan-agent@localhost${workerRepo}` : workerRepo;

    // 1. Only the hub publishes to the central bare repository.
    await git(root, "init", "--bare", "--initial-branch=main", central);
    await git(root, "clone", "--no-local", central, integration);
    await writeFile(join(integration, "README.md"), "baseline\n");
    await git(integration, "add", "README.md");
    await git(integration, "commit", "-m", "Create baseline");
    await git(integration, "push", "origin", "main");
    const base = await git(central, "rev-parse", "main");

    // 2. Seed origin/main from the hub, leaving the worker's parked checkout intact.
    await workerCommand("mkdir", ["-p", workerRepo]);
    await workerGit(workerRepo, "init", "--initial-branch=parked");
    await workerWrite(join(workerRepo, "parked.txt"), "do not change this checkout\n");
    await workerGit(workerRepo, "add", "parked.txt");
    await workerGit(workerRepo, "commit", "-m", "Park worker checkout");
    const before = await workerGit(workerRepo, "rev-parse", "HEAD");
    checked(await gitResult(central, ["push", source, "refs/heads/main:refs/remotes/origin/main"], transportEnv));
    assert.equal(await workerGit(workerRepo, "rev-parse", "HEAD"), before);
    assert.equal(await workerGit(workerRepo, "symbolic-ref", "HEAD"), "refs/heads/parked");
    assert.equal(await workerGit(workerRepo, "status", "--porcelain"), "");
    assert.equal(await workerCommand("cat", [join(workerRepo, "parked.txt")]), "do not change this checkout");
    assert.equal(await workerGit(workerRepo, "rev-parse", "refs/remotes/origin/main"), base);
    assert.equal(await workerGit(workerRepo, "remote"), "");
    event("baseline", { checkoutUnchanged: true, workerRemotes: 0 });

    // 3. Worker commits; it never fetches or pushes.
    await workerGit(workerRepo, "worktree", "add", "-b", "agent/C-1/W-1", worktree, "refs/remotes/origin/main");
    const commits = [];
    for (const [file, text] of [["first.txt", "first\n"], ["second.txt", "second\n"]]) {
      await workerWrite(join(worktree, file), text);
      await workerGit(worktree, "add", file);
      await workerGit(worktree, "commit", "-m", `Add ${file}`);
      commits.push(await workerGit(worktree, "rev-parse", "HEAD"));
    }
    await workerGit(workerRepo, "branch", "agent/C-2/W-1", base);

    // 4. Fetch a named branch snapshot before accepting an exact commit SHA.
    // The sibling object exists at the hub, but is not an ancestor of the worker branch.
    const sibling = await git(central, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "Unrelated sibling");
    const decisions = [];
    for (const [sha, reason] of [[commits[0], "accepted"], ["f".repeat(40), "missing-object"], [sibling, "not-in-branch"]]) {
      const incoming = "refs/cardigan/incoming/D-1";
      checked(await fetch(source, `+${branch}:${incoming}`));
      let actual;
      if ((await gitResult(central, ["cat-file", "-e", `${sha}^{commit}`])).code !== 0) actual = "missing-object";
      else if ((await gitResult(central, ["merge-base", "--is-ancestor", sha, incoming])).code !== 0) actual = "not-in-branch";
      else { await git(central, "update-ref", delivery, sha); actual = "accepted"; }
      assert.equal(actual, reason);
      assert.equal(await git(central, "rev-parse", delivery), commits[0]);
      await git(central, "update-ref", "-d", incoming);
      decisions.push(actual);
    }
    assert.notEqual(commits[0], commits[1]);
    event("delivery", { decisions, pinnedToRequestedAncestor: true, rejectedAttemptsPreservedRef: true });

    // 5. One refspec covers multiple branches, with a machine-specific destination.
    checked(await fetch(source, "+refs/heads/agent/*:refs/cardigan/backups/worker-a/agent/*"));
    assert.equal(await git(central, "rev-parse", backup), commits[1]);
    assert.equal(await git(central, "rev-parse", "refs/cardigan/backups/worker-a/agent/C-2/W-1"), base);
    event("backup", { branches: 2, latestCheckpoint: commits[1] });

    // 6. Faults change only this fetch's endpoint; no other host is contacted.
    const faults = [];
    if (mode === "local") {
      await rename(workerRepo, `${workerRepo}.offline`);
      faults.push({ kind: "missing-path", ...await fetch(source, `+${branch}:${backup}`) });
    } else {
      for (const kind of ["refused", "timeout"]) {
        const sockets = new Set();
        const listener = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
        await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
        const port = listener.address().port;
        if (kind === "refused") await new Promise((resolve) => listener.close(resolve));
        try {
          faults.push({ kind, ...await fetch(source, `+${branch}:${backup}`, { GIT_SSH_COMMAND: `${sshCommand} -p ${port}` }) });
        } finally {
          for (const socket of sockets) socket.destroy();
          if (listener.listening) await new Promise((resolve) => listener.close(resolve));
        }
      }
    }
    for (const fault of faults) {
      assert.equal(fault.code, 128);
      assert.ok(!fault.killed, "SSH timeout must come from ConnectTimeout, not the outer process deadline");
      if (fault.kind === "timeout") { assert.match(fault.stderr, /timed out/i); assert.ok(fault.ms >= 2500 && fault.ms < 10000); }
      if (fault.kind === "refused") assert.match(fault.stderr, /Connection refused/);
      fault.stderr = fault.stderr.replaceAll(workerRoot, "<worker>").replaceAll(root, "<hub>");
      event("fetch-failed", fault);
    }
    assert.equal(await git(central, "rev-parse", backup), commits[1]);

    // A fresh repository simulates a replacement machine, seeded by the hub.
    const replacement = join(root, "replacement");
    const resumed = join(replacement, "worktree");
    await git(root, "init", "--initial-branch=parked", replacement);
    await git(central, "push", replacement, `${backup}:refs/remotes/origin/checkpoint`);
    await git(replacement, "worktree", "add", "-b", "agent/C-1/W-1", resumed, "refs/remotes/origin/checkpoint");
    assert.equal(await git(resumed, "rev-parse", "HEAD"), commits[1]);
    await writeFile(join(resumed, "takeover.txt"), "resumed from last fetched checkpoint\n");
    await git(resumed, "add", "takeover.txt");
    await git(resumed, "commit", "-m", "Continue on replacement worker");
    const resumedSha = await git(resumed, "rev-parse", "HEAD");
    checked(await fetch(replacement, `+${branch}:refs/cardigan/deliveries/D-2`));
    assert.equal(await git(central, "rev-parse", "refs/cardigan/deliveries/D-2"), resumedSha);
    assert.equal(await git(central, "rev-parse", `${resumedSha}^`), commits[1]);
    event("takeover", { continued: true, fetchedByHub: true });

    // 7. Merge only in the hub integration clone and publish to the temporary central repo.
    await git(integration, "fetch", "origin", "refs/cardigan/deliveries/D-2");
    await git(integration, "merge", "--no-ff", "--no-edit", "FETCH_HEAD");
    await git(integration, "push", "origin", "main");
    const tree = await git(central, "ls-tree", "--name-only", "main");
    assert.equal(await git(central, "rev-parse", "main^1"), base);
    assert.equal(await git(central, "rev-parse", "main^2"), resumedSha);
    event("merged", { files: tree.split("\n") });
    return { root, workerRoot, decisions, faults, files: tree.split("\n"),
      content: await git(central, "show", "main:takeover.txt") };
  } finally {
    try {
      if (mode === "ssh" && workerRoot) {
        assert.match(workerRoot, /^\/tmp\/cardigan-p0-git-worker-[A-Za-z0-9]+$/);
        const result = await ssh(`rm -rf -- ${quote(workerRoot)} && test ! -e ${quote(workerRoot)}`);
        assert.equal(result.code, 0, `Cleanup failed for task-owned directory ${workerRoot}: ${result.stderr}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    event("cleaned", { local: true, worker: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runScenario(process.argv[2] ?? "local");
}
