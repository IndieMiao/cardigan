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


def preflight(config):
    require(platform.system() == 'Darwin' and platform.machine() == 'arm64' and os.geteuid() == 0)
    require(re.fullmatch(r'[a-z_][a-z0-9_-]*', config['account']) is not None)
    account = pwd.getpwnam(config['account'])
    require(account.pw_uid == config['uid'] and account.pw_uid > 0)
    require(os.getgrouplist(account.pw_name, account.pw_gid) == [account.pw_gid])
    # HOME is obtained from directory services, never inherited from the controller.
    home = Path(account.pw_dir)
    require(home.is_dir() and home == home.resolve())
    denial = subprocess.run(['/usr/bin/sudo', '-n', '-l', '-U', account.pw_name],
                            capture_output=True, text=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    require('is not allowed to run sudo' in denial.stdout + denial.stderr)
    root, mount = Path(config['root']), Path(config['mount'])
    protected(root)
    require(mount == mount.resolve() and os.path.ismount(mount) and root.is_relative_to(mount))
    require(str(os.statvfs(mount).f_fsid) == config['volume'])
    for path, key in [(Path('/'), 'root'), (root, 'work')]:
        minimum = config['minimum_free_bytes'][key]
        require(type(minimum) is int and minimum > 0)
        space = os.statvfs(path)
        require(space.f_bavail * space.f_frsize >= minimum)
    marker = root / '.cardigan-worker'
    info = marker.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600)
    require(json.loads(marker.read_text()) == {'project': config['project'], 'uid': account.pw_uid, 'home': str(home)})
    for path in [root, home]:
        acl = subprocess.run(['/bin/ls', '-lde', str(path)], capture_output=True, text=True, check=True)
        require(not re.search(r'^\s*\d+:', acl.stdout, re.M))
    return account, root


def apply(account, root):
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
    account, root = preflight(json.loads(config_path.read_text()))
    if args.apply:
        apply(account, root)
    print('worker_installation_checked' if args.check else 'worker_installation_applied')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('worker_preflight_failed', file=sys.stderr)
        sys.exit(1)
