#!/usr/bin/env python3
"""Operator-run macOS worker setup. Accounts, App, TCC and login stay manual."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import runpy
import stat
import subprocess
import sys


def require(condition):
    if not condition:
        raise ValueError('worker_preflight_failed')


def protected(path):
    require(path.is_absolute() and path == path.resolve() and '..' not in path.parts)
    for parent in [path, *path.parents]:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)


def layout(account, root):
    native = runpy.run_path(str(Path(__file__).with_name('worker-primitives.py')))
    entries = [(root / name, 0 if name in ('locks', 'libexec') else account.pw_uid,
                0o750 if name in ('locks', 'libexec') else 0o700, True)
               for name in ('repos', 'worktrees', 'builds', 'cache', 'generated', 'evidence', 'temporary', 'locks', 'libexec')]
    entries += [(root / 'locks' / (name + '.lock'), 0, 0o660, False) for name in ('git', 'tests')]
    entries += [(root / 'libexec' / 'worker-primitives.py', 0, 0o750, False)]
    for path, uid, mode, is_dir in entries:
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        require((stat.S_ISDIR(info.st_mode) if is_dir else stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                and info.st_uid == uid and info.st_gid == account.pw_gid and stat.S_IMODE(info.st_mode) == mode)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require(native['acl_safe'](fd))
        finally:
            os.close(fd)
        if not is_dir:
            require(path.read_bytes() == (b'' if path.suffix == '.lock' else Path(__file__).with_name('worker-primitives.py').read_bytes()))
    return entries


def preflight(config):
    require(platform.system() == 'Darwin' and platform.machine() == 'arm64' and os.geteuid() == 0)
    require(re.fullmatch(r'[a-z_][a-z0-9_-]*', config['account']) is not None)
    account = pwd.getpwnam(config['account'])
    require(account.pw_uid == config['uid'] and account.pw_uid > 0)
    require(set(os.getgrouplist(account.pw_name, account.pw_gid)) == {account.pw_gid})
    # HOME is obtained from directory services, never inherited from the controller.
    home = Path(account.pw_dir)
    protected(home)
    denial = subprocess.run(['/usr/bin/sudo', '-n', '-l', '-U', account.pw_name],
                            capture_output=True, text=True, timeout=config['timeout_ms'] / 1000,
                            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    require(denial.returncode in (0, 1) and 'is not allowed to run sudo' in denial.stdout + denial.stderr)
    root, mount = Path(config['root']), Path(config['mount'])
    protected(root)
    require(len(root.parts) >= 3 and root != mount)
    require(mount == mount.resolve() and os.path.ismount(mount) and root.is_relative_to(mount))
    require(str(os.statvfs(mount).f_fsid) == config['volume'] and root.stat().st_dev == mount.stat().st_dev)
    for path, key in [(Path('/'), 'root'), (root, 'work')]:
        minimum = config['minimum_free_bytes'][key]
        require(type(minimum) is int and minimum > 0)
        space = os.statvfs(path)
        require(space.f_bavail * space.f_frsize >= minimum)
    marker = root / '.cardigan-worker'
    info = marker.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600)
    require(json.loads(marker.read_text()) == {'project': config['project'], 'uid': account.pw_uid, 'home': str(home)})
    native = runpy.run_path(str(Path(__file__).with_name('worker-primitives.py')))
    for path in [root, home]:
        fd = native['directory'](str(path), 0)
        os.close(fd)
    layout(account, root)  # All existing conflicts are checked before the first mutation.
    return account, root


def apply(account, root):
    layout(account, root)
    for name in ['repos', 'worktrees', 'builds', 'cache', 'generated', 'evidence', 'temporary', 'locks', 'libexec']:
        path = root / name
        owner = 0 if name in ['locks', 'libexec'] else account.pw_uid
        mode = 0o750 if owner == 0 else 0o700
        try:
            path.mkdir(mode=mode)
            os.chown(path, owner, account.pw_gid)
        except FileExistsError:
            pass
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner and info.st_gid == account.pw_gid and stat.S_IMODE(info.st_mode) == mode)
    # Never replace the lock inode, including on a repeated application.
    for name in ['git', 'tests']:
        path = root / 'locks' / f'{name}.lock'
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o660)
            os.fchown(fd, 0, account.pw_gid)
            os.fchmod(fd, 0o660)
            os.close(fd)
        except FileExistsError:
            pass
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == 0 and info.st_uid == 0 and info.st_gid == account.pw_gid and stat.S_IMODE(info.st_mode) == 0o660)
    source = Path(__file__).with_name('worker-primitives.py').read_bytes()
    target = root / 'libexec' / 'worker-primitives.py'
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o750)
        with os.fdopen(fd, 'wb') as out:
            out.write(source)
            os.fchown(out.fileno(), 0, account.pw_gid)
            os.fchmod(out.fileno(), 0o750)
    except FileExistsError:
        info = target.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o750)
        require(hashlib.sha256(target.read_bytes()).digest() == hashlib.sha256(source).digest())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--dry-run', action='store_true')
    modes.add_argument('--check', action='store_true')
    modes.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.dry_run:
        print(json.dumps({'platform': 'darwin', 'arch': 'arm64', 'hc': '0.1.18',
                          'steps': ['verify operator-prepared account and marker', 'verify mount, space and ACL',
                                    'create private worker directories', 'install protected helper and lock inodes'],
                          'manual': ['account', 'signed-app', 'tools', 'ssh', 'tcc', 'login']}))
        return
    config_path = Path(args.config)
    protected(config_path.parent)
    info = config_path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077)
    require(info.st_nlink == 1 and info.st_size <= 65536)
    config = json.loads(config_path.read_text())
    require(type(config.get('timeout_ms')) is int and 0 < config['timeout_ms'] <= 2147483647)
    account, root = preflight(config)
    if args.apply:
        apply(account, root)
    print(json.dumps({'installation': 'checked' if args.check else 'applied', 'uid': account.pw_uid,
                      'capabilities_verified': False, 'remote_enabled': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('worker_preflight_failed', file=sys.stderr)
        sys.exit(1)
