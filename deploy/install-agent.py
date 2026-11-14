#!/usr/bin/env python3
"""Provision Cardigan's Linux agent account. Run --dry-run first, then with sudo."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import pwd
import grp
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.request

VERSION = "0.1.18"
# Official 0.1.18 release manifest; the x86_64 archive was also checked locally.
CHECKSUMS = {
    "x86_64": "5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7",
    "aarch64": "cf33393cf950bb763734dc3e16610ab9daf8492391a4ef0de56026cd7f752853",
}
AGENT = "agent"
GROUP = "cardigan-share"
AGENT_HOME = Path("/var/lib/cardigan-agent")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, user=None):
    command = [str(v) for v in args]
    if user:
        command = ["runuser", "-u", user, "--", *command]
    return subprocess.run(command, check=True, text=True, capture_output=True).stdout.strip()


def has_sudo_rights(user):
    result = subprocess.run(
        ["sudo", "-n", "-l", "-U", user], capture_output=True, text=True,
        env={**os.environ, "LC_ALL": "C", "LANG": "C"},
    )
    # sudo-rs can return 0 for an explicit denial; unknown successful output is unsafe.
    return result.returncode == 0 and "is not allowed to run sudo" not in (
        result.stdout + "\n" + result.stderr
    )


def plain_path(path):
    require(path.is_absolute() and ".." not in path.parts, "Paths must be absolute without '..'")
    require(len(path.parts) >= 3, "Refusing a top-level system directory")
    for parent in [path, *path.parents]:
        require(not parent.is_symlink(), f"Refusing symlink: {parent}")


def separate(a, b):
    return a != b and a not in b.parents and b not in a.parents


def directory(path, uid, gid, mode):
    plain_path(path)
    run("install", "-d", "-o", uid, "-g", gid, "-m", oct(mode)[2:], path)
    run("setfacl", "-b", "-k", path)
    os.chmod(path, mode)


def atomic_file(path, content, uid, gid, mode):
    fd, temporary = tempfile.mkstemp(prefix=".cardigan-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(content)
            os.fchown(out.fileno(), uid, gid)
            os.fchmod(out.fileno(), mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def payload(archive, arch):
    require(arch in CHECKSUMS, "Supported architectures: x86_64, aarch64")
    url = f"https://releases.herdr.dev/core/{VERSION}/herdr-core-linux-{arch}.tar.gz"
    if archive:
        data = archive.read_bytes()
    else:
        request = urllib.request.Request(url, headers={"User-Agent": "Cardigan installer"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read()
    require(hashlib.sha256(data).hexdigest() == CHECKSUMS[arch], "hc archive sha256 mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as bundle:
        member = bundle.getmember("herdr-core")
        require(member.isfile(), "hc archive must contain a regular herdr-core binary")
        return bundle.extractfile(member).read()


def optional_record(lookup, name):
    try:
        return lookup(name)
    except KeyError:
        return None


def preflight(args):
    """Read-only: no account, directory, key, ACL or package changes."""
    require(platform.system() == "Linux" and os.geteuid() == 0, "Check/apply requires Linux and sudo")
    for command in ["sudo", "useradd", "groupadd", "usermod", "passwd", "runuser", "ssh-keygen", "sshd", "setfacl", "install", "mkdir"]:
        require(shutil.which(command), f"Install prerequisite: {command}")
    run("sudo", "-V")
    host = pwd.getpwnam(args.host_user)
    require(host.pw_uid != 0, "Host must not be root")
    host_home = Path(host.pw_dir)
    plain_path(host_home)
    require(host_home.is_dir(), "Host home is missing")
    home = host_home.stat()
    require(not home.st_mode & stat.S_IXOTH, "Host home allows other users to traverse it; restrict permissions before installing")
    require(separate(args.agent_root, host_home), "Agent root must be outside the host home")
    agent = optional_record(pwd.getpwnam, AGENT)
    shared = optional_record(grp.getgrnam, GROUP)
    if shared:
        require(set(shared.gr_mem) <= {host.pw_name, AGENT}, "Shared group contains other users")
        require(not any(p.pw_gid == shared.gr_gid and p.pw_name not in [host.pw_name, AGENT] for p in pwd.getpwall()),
                "Shared group is another user's primary group")
    identity = {"host": host.pw_name, "data": str(args.data_dir), "root": str(args.agent_root)}
    marker = AGENT_HOME / ".cardigan-managed"
    if agent:
        require(marker.is_file() and not marker.is_symlink() and marker.stat().st_uid == 0
                and stat.S_IMODE(marker.stat().st_mode) == 0o600 and AGENT_HOME.stat().st_uid == 0,
                "Existing agent account is not managed by this installer")
        require(json.loads(marker.read_text()) == identity and agent.pw_dir == str(AGENT_HOME),
                "Existing installation has different ownership or roots")
        allowed_groups = {agent.pw_gid} | ({shared.gr_gid} if shared else set())
        require(set(os.getgrouplist(AGENT, agent.pw_gid)) <= allowed_groups, "Agent has additional groups (possibly privileged)")
        require(not has_sudo_rights(AGENT),
                "Agent has sudo rights; remove them before proceeding")
        require(subprocess.run(["runuser", "-u", AGENT, "--", "test", "-x", str(host_home)]).returncode != 0,
                "Host home is accessible to agent")
    else:
        require(not AGENT_HOME.exists(), "Unmanaged agent home already exists")
        require(optional_record(grp.getgrnam, AGENT) is None, "Agent primary group already exists without a managed account")
    prospective_groups = ({agent.pw_gid} if agent else set()) | ({shared.gr_gid} if shared else set())
    require(not (home.st_gid in prospective_groups and home.st_mode & stat.S_IXGRP), "Agent's planned group can traverse the host home")
    # Do not alter sshd_config; refuse alternative account authentication sources.
    effective = run("sshd", "-T", "-C", "user=agent,host=localhost,addr=127.0.0.1")
    settings = dict(line.split(" ", 1) for line in effective.splitlines() if " " in line)
    for name, expected in [("pubkeyauthentication", "yes"), ("hostbasedauthentication", "no"),
                           ("authorizedkeyscommand", "none"), ("trustedusercakeys", "none"),
                           ("kbdinteractiveauthentication", "no"), ("gssapiauthentication", "no")]:
        require(settings.get(name) == expected, f"Unsupported SSH setting: {name}")
    require(set(settings.get("authorizedkeysfile", "").split()) <= {".ssh/authorized_keys", ".ssh/authorized_keys2"}
            and ".ssh/authorized_keys" in settings.get("authorizedkeysfile", ""), "Unexpected SSH authorized_keys locations")
    host_keys = [Path(line.split(" ", 1)[1] + ".pub") for line in effective.splitlines() if line.startswith("hostkey ")]
    host_key = next((p.read_text().split()[:2] for p in host_keys if p.is_file() and p.read_text().startswith("ssh-ed25519 ")), None)
    require(host_key, "sshd must have an ed25519 host key")
    private = host_home / ".config/cardigan/agent-ssh"
    paths = [args.data_dir, args.agent_root, private, AGENT_HOME, AGENT_HOME / ".ssh",
             *(args.agent_root / child for child in ["runs", "repos", "worktrees"]),
             *(AGENT_HOME / child for child in [".local", ".local/bin", ".config", ".cache", ".local/state", ".local/share"])]
    for path in paths:
        plain_path(path)
        require(not path.exists() or path.is_dir(), f"Directory path is occupied: {path}")
    ssh_dir = AGENT_HOME / ".ssh"
    if ssh_dir.exists():
        require(not any(p.name != "authorized_keys" for p in ssh_dir.iterdir()), "Agent .ssh contains unmanaged files or keys")
    key = private / "id_ed25519"
    if key.exists() or key.is_symlink():
        require(key.is_file() and not key.is_symlink() and key.stat().st_uid == host.pw_uid
                and stat.S_IMODE(key.stat().st_mode) == 0o600, "Dedicated key must be host-owned 0600")
        require(run("ssh-keygen", "-y", "-f", key, user=host.pw_name).startswith("ssh-ed25519 "), "Dedicated key must be ed25519")
    # A read-only preflight must not fetch or install anything.
    binary = None if args.check else payload(args.archive, platform.machine())
    return host, agent, shared, identity, private, host_key, binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-user", required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--agent-root", type=Path, default=Path("/srv/cardigan-agent"))
    parser.add_argument("--archive", type=Path, help="Optional offline archive; still SHA256 checked")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true", help="Print the plan; no writes, downloads or privileged commands")
    modes.add_argument("--check", action="store_true", help="Run all read-only preflight checks with sudo; do not install")
    args = parser.parse_args()
    require(re.fullmatch(r"[a-z_][a-z0-9_-]*", args.host_user) and args.host_user not in ["root", AGENT], "Invalid host user")
    for path in [args.data_dir, args.agent_root]:
        plain_path(path)
    require(separate(args.data_dir, args.agent_root), "Data and agent roots must be disjoint")
    plan = {
        "version": VERSION, "host_user": args.host_user, "agent_user": AGENT,
        "agent_home": str(AGENT_HOME), "shared_group": GROUP,
        "data_dir": str(args.data_dir), "data_mode": "0700",
        "agent_root": str(args.agent_root), "parent_mode": "2750",
        "assignment_directory_mode": "2770", "credential_mode": "0660",
        "steps": ["read-only account/group/SSH/path preflight", "verify pinned hc archive sha256", "create or verify managed agent account",
                  "lock password; reject sudo and extra memberships", "verify host home is inaccessible",
                  "create shared group with exactly host and agent", "install root-owned hc 0.1.18",
                  "generate/reuse host-only dedicated ed25519 key", "pin localhost SSH host key",
                  "install one loopback-only restricted authorized key", "set protected roots and default ACLs",
                  "write host-only runtime environment configuration"],
        "changes_ssh_config": False, "checksums": CHECKSUMS,
    }
    if args.dry_run:
        print(json.dumps(plan, indent=2))
        return
    host, agent, shared, identity, private, host_key, binary = preflight(args)
    if args.check:
        print("Read-only checks passed; no installation changes made.")
        return
    # First mutation: all checks independent of the new account have passed.
    marker = AGENT_HOME / ".cardigan-managed"
    if agent is None:
        run("useradd", "--system", "--user-group", "--no-create-home", "--home-dir", AGENT_HOME, "--shell", "/bin/sh", AGENT)
        agent = pwd.getpwnam(AGENT)
        directory(AGENT_HOME, 0, agent.pw_gid, 0o750)
        atomic_file(marker, json.dumps(identity).encode(), 0, 0, 0o600)
    if shared is None:
        run("groupadd", "--system", GROUP)
        shared = grp.getgrnam(GROUP)
    run("passwd", "--lock", AGENT)
    require(not has_sudo_rights(AGENT),
            "New agent account has sudo rights; installation stopped")
    for user in [host.pw_name, AGENT]:
        run("usermod", "-a", "-G", GROUP, user)
    require(subprocess.run(["runuser", "-u", AGENT, "--", "test", "-x", host.pw_dir]).returncode != 0,
            "Agent can traverse host home after group assignment; installation stopped")
    directory(AGENT_HOME, 0, agent.pw_gid, 0o750)
    for parent in [AGENT_HOME / ".local", AGENT_HOME / ".local/bin"]:
        directory(parent, 0, agent.pw_gid, 0o750)
    for parent in [AGENT_HOME / ".config", AGENT_HOME / ".cache", AGENT_HOME / ".local/state", AGENT_HOME / ".local/share"]:
        directory(parent, agent.pw_uid, agent.pw_gid, 0o700)
    for name in ["herdr-core", "hc"]:
        atomic_file(AGENT_HOME / ".local/bin" / name, binary, 0, agent.pw_gid, 0o750)
    require(run(AGENT_HOME / ".local/bin/hc", "--version", user=AGENT) == f"hc {VERSION}", "Installed hc version mismatch")
    run("mkdir", "-p", private, user=host.pw_name)
    directory(private, host.pw_uid, host.pw_gid, 0o700)
    key = private / "id_ed25519"
    if not key.exists():
        run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "cardigan-agent-local", "-f", key, user=host.pw_name)
    require(not key.is_symlink() and key.stat().st_uid == host.pw_uid and stat.S_IMODE(key.stat().st_mode) == 0o600, "Dedicated key must be host-owned 0600")
    public = run("ssh-keygen", "-y", "-f", key, user=host.pw_name)
    require(public.startswith("ssh-ed25519 "), "Dedicated key must be ed25519")
    ssh_dir = AGENT_HOME / ".ssh"
    directory(ssh_dir, 0, agent.pw_gid, 0o750)
    atomic_file(ssh_dir / "authorized_keys", f'from="127.0.0.1,::1",restrict {public}\n'.encode(), 0, agent.pw_gid, 0o640)
    atomic_file(private / "known_hosts", ("cardigan-agent-local " + " ".join(host_key) + "\n").encode(), host.pw_uid, host.pw_gid, 0o600)
    directory(args.data_dir, host.pw_uid, host.pw_gid, 0o700)
    for path in [args.agent_root, *(args.agent_root / child for child in ["runs", "repos", "worktrees"])]:
        directory(path, host.pw_uid, shared.gr_gid, 0o2750)
        run("setfacl", "-m", "d:u::rwx,d:g::rwx,d:m::rwx,d:o::---", path)
    require(subprocess.run(["runuser", "-u", AGENT, "--", "test", "-r", str(args.data_dir)]).returncode != 0, "Agent can read data directory")
    config = {"CARDIGAN_RUNTIME_MODE": "agent-ssh", "CARDIGAN_DATA_DIR": str(args.data_dir),
              "CARDIGAN_AGENT_ROOT": str(args.agent_root), "CARDIGAN_AGENT_GID": str(shared.gr_gid),
              "CARDIGAN_AGENT_IDENTITY": str(key), "CARDIGAN_AGENT_KNOWN_HOSTS": str(private / "known_hosts"),
              "CARDIGAN_AGENT_MACHINE": "cardigan-agent"}
    quote = lambda value: "'" + value.replace("'", "'\\''") + "'"
    atomic_file(private / "runtime.env", "".join(f"export {k}={quote(v)}\n" for k, v in config.items()).encode(), host.pw_uid, host.pw_gid, 0o600)
    print(f"Installed. Start a new host login to refresh groups, then source {private / 'runtime.env'}")
    print("Agent CLI binaries and scoped provider credentials must be provisioned separately; no host credentials were copied.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"cardigan installer: {error}") from None
