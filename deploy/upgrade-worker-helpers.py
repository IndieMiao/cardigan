"""Run only from the verified administrator copy. Binding and manifest come from the controller."""
import base64
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


def upgrade_files(work, release, live, lib, gid, b, installed, run_installer):
    # The caller holds the protected installation-directory lock. Never overwrite a
    # previous backup; a partially completed upgrade needs an operator, not a retry.
    tag = b['rev'][:12]
    backup = live.with_name('deploy.bak-' + tag)
    pending = live.with_name('deploy.new-' + tag)
    require(not os.path.lexists(backup) and not os.path.lexists(pending), 'existing_deploy_backup_or_stage')
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

    shutil.copytree(release, pending)
    # Recheck the actual new tree on the destination volume before moving the live tree.
    require({p.relative_to(pending).as_posix(): digest(p) for p in pending.rglob('*') if p.is_file()} == manifest,
            'deploy_copy_digest')
    for p in (pending, *pending.rglob('*')):
        os.chown(p, 0, 0)  # root:root (Linux), root:wheel (Darwin)
    live.rename(backup)
    print('deploy 备份：', backup, flush=True)
    pending.rename(live)
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
    config_path = Path('/Library/Cardigan/worker.json' if mac else '/etc/cardigan/worker.json')
    cfg = installer['trusted_json'](config_path)
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
                      lambda p: installed_digest(p, account.pw_gid, native['acl_safe']), check)
    finally:
        os.close(fd)
