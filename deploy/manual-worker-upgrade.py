"""Run only from the verified administrator copy. Binding and manifest come from the controller."""
import base64
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import runpy
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile


DEPLOY_OWNER = (0, 0)  # root:root (Linux), root:wheel (Darwin)
HELPERS = ('worker-primitives.py', 'worker-files.py', 'worker-git.py')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def unpack(archive, dest, manifest):
    seen = set()
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = Path(member.name)
            require(name.parts[:1] == ('deploy',) and '..' not in name.parts, 'unexpected_deploy_path')
            path = dest / name
            if member.isdir():
                path.mkdir()
                path.chmod(0o755)
            else:
                rel = name.relative_to('deploy').as_posix()
                require(member.isfile() and rel in manifest, 'unexpected_deploy_file')
                with tar.extractfile(member) as src, path.open('xb') as out:
                    shutil.copyfileobj(src, out)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
                require(digest(path) == manifest[rel], 'deploy_file_digest: ' + rel)
                seen.add(rel)
    require(seen == manifest.keys(), 'incomplete_deploy_manifest')


def installed_digest(path, gid, acl_safe):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as f:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0 and
                s.st_gid == gid and stat.S_IMODE(s.st_mode) == 0o750 and acl_safe(fd),
                'unsafe_installed_helper: ' + path.name)
        return hashlib.sha256(f.read()).hexdigest()


def install(source, target, gid):
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as out:
        with source.open('rb') as src:
            shutil.copyfileobj(src, out)
        os.fchown(out.fileno(), 0, gid)
        os.fchmod(out.fileno(), 0o750)
    os.replace(out.name, target)


def exchange_directories(live, pending):
    # Both names are on the same protected volume. Unsupported filesystems fail
    # closed; two successive renames would temporarily remove the shared entry.
    libc = ctypes.CDLL(None, use_errno=True)
    paths = os.fsencode(live), os.fsencode(pending)
    if platform.system() == 'Darwin':
        result = libc.renamex_np(*paths, 2)  # RENAME_SWAP
    else:
        result = libc.renameat2(-100, paths[0], -100, paths[1], 2)  # AT_FDCWD, RENAME_EXCHANGE
    if result != 0:
        raise OSError(ctypes.get_errno(), 'deploy_atomic_exchange_failed')


def matches_release(live, release, manifest, acl_safe):
    # Only descend into protected directories and hash regular files of the
    # verified release's size. Identical bytes in a writable tree are not a hit.
    def same(path, expected):
        s = path.lstat()
        e = expected.stat()
        if ((s.st_uid, s.st_gid) != DEPLOY_OWNER or s.st_mode != e.st_mode
                or s.st_mode & 0o022):
            return False
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not acl_safe(fd):
                return False
            if stat.S_ISDIR(s.st_mode):
                return (set(os.listdir(path)) == set(os.listdir(expected)) and
                        all(same(path / n, expected / n) for n in os.listdir(expected)))
            return (stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size == e.st_size
                    and digest(path) == manifest[path.relative_to(live).as_posix()])
        finally:
            os.close(fd)
    return same(live, release)


def upgrade_files(work, release, live, lib, gid, b, installed, run_installer, acl_safe):
    # The caller holds the protected installation-directory lock. Never overwrite a
    # previous backup; a partially completed upgrade needs an operator, not a retry.
    tag = b['rev'][:12]
    # The release directory is shared; keep a distinct restore point per binding.
    deploy_tag = tag + '-' + hashlib.sha256(b['project'].encode()).hexdigest()[:20]
    backup = live.with_name('deploy.bak-' + deploy_tag)
    pending = live.with_name('deploy.new-' + deploy_tag)
    require(not any(os.path.lexists(p) for p in (backup, pending, live.with_name('deploy.bak-' + tag),
            live.with_name('deploy.new-' + tag))), 'existing_deploy_backup_or_stage')
    mac = b['os'] == 'darwin'
    manifest = b['manifest']
    old = {n: installed(lib / n) for n in HELPERS}
    for name in HELPERS:
        if old[name] is None or old[name] == manifest[name]:
            continue
        dest = (work / name if not mac and name == HELPERS[0] else lib / (name + '.bak-' + tag))
        require(not os.path.lexists(dest), 'existing_helper_backup: ' + name)
        # The root-private backup may be on a different filesystem than libexec.
        with (lib / name).open('rb') as src, dest.open('xb') as out:
            shutil.copyfileobj(src, out)
            os.fchown(out.fileno(), 0, gid)
            os.fchmod(out.fileno(), 0o750)
        require(digest(dest) == old[name], 'helper_backup_digest: ' + name)
        print('helper 备份：', dest, flush=True)

    if not matches_release(live, release, manifest, acl_safe):
        shutil.copytree(release, pending)
        require({p.relative_to(pending).as_posix(): digest(p) for p in pending.rglob('*') if p.is_file()} == manifest,
                'deploy_copy_digest')
        for p in (pending, *pending.rglob('*')):
            os.chown(p, *DEPLOY_OWNER)
        exchange_directories(live, pending)
        # After the single switch even an interruption here leaves live usable;
        # pending still contains the untouched old tree until filed as a backup.
        pending.rename(backup)
        print('deploy 备份：', backup, flush=True)
    if not mac:
        name = HELPERS[0]
        if old[name] is not None and old[name] != manifest[name]:
            (lib / name).unlink()  # layout refuses stale primitives; backup verified above
        run_installer('--check')
        run_installer('--apply')
    for name in (HELPERS if mac else HELPERS[1:]):
        if old[name] != manifest[name]:
            install(live / name, lib / name, gid)
    if mac:
        run_installer('--check')
    for name in HELPERS:
        require(installed(lib / name) == manifest[name], 'installed_helper_mismatch: ' + name)
    print('升级完成')


def upgrade(encoded):
    b = json.loads(base64.b64decode(encoded))
    mac = b['os'] == 'darwin'
    require(os.geteuid() == 0 and platform.system() == ('Darwin' if mac else 'Linux'), 'unexpected_platform')
    work = Path.cwd()
    require(work.stat().st_uid == 0 and stat.S_IMODE(work.stat().st_mode) == 0o700, 'private_copy_required')
    print('工作目录：', work, flush=True)
    archive = work / 'deploy.tar.gz'
    require(digest(archive) == b['bundleSha'], 'deploy_archive_digest')
    unpack(archive, work, b['manifest'])
    release = work / 'deploy'
    installer = runpy.run_path(str(release / 'install-macos-worker.py'))
    native = runpy.run_path(str(release / 'worker-primitives.py'))
    live = Path('/opt/cardigan/deploy')
    config_path, cfg = installer['select_binding'](installer['binding_inventory'](platform.system()), b['project'])
    account = pwd.getpwnam(cfg['account'])
    require(cfg['project'] == b['project'] and cfg['root'] == b['root'] and
            cfg['account'] == b['account'] and cfg['uid'] == account.pw_uid > 0 and
            b['gid'] == account.pw_gid, 'worker_binding_changed')
    root = Path(cfg['root'])
    require(installer['trusted_json'](root / '.cardigan-worker') == {
        'project': b['project'], 'uid': account.pw_uid, 'home': account.pw_dir}, 'worker_marker_changed')
    lib = root / 'libexec'
    installer['protected'](lib)
    fd = native['directory'](str(live.parent), 0)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        installer['protected'](live)
        entry = live / ('install-macos-worker.py' if mac else 'install-linux-worker.py')
        def check(flag):
            subprocess.run([sys.executable, '-IB', str(entry), '--config', str(config_path), flag], check=True)
        upgrade_files(work, release, live, lib, account.pw_gid, b,
                      lambda p: installed_digest(p, account.pw_gid, native['acl_safe']), check, native['acl_safe'])
    finally:
        os.close(fd)
