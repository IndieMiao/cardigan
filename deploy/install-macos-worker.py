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
    native = runpy.run_path(str(Path(__file__).with_name('worker-primitives.py')))
    os.close(native['directory'](str(path), 0))


def trusted_json(path, mode=0o600):
    native = runpy.run_path(str(Path(__file__).with_name('worker-primitives.py')))
    parent = native['directory'](str(path.parent), 0)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as file:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                    and stat.S_IMODE(before.st_mode) == mode and before.st_size <= 65536 and native['acl_safe'](fd))
            def same_name():
                name = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                require((name.st_dev, name.st_ino) == (before.st_dev, before.st_ino))
            same_name()
            data = file.read(65537)
            after = os.fstat(fd)
            require(len(data) == before.st_size and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    == (after.st_size, after.st_mtime_ns, after.st_ctime_ns))
            same_name()
            return json.loads(data)
    finally:
        os.close(parent)


def directories(account, root):
    project = trusted_json(root / '.cardigan-worker')['project']
    require(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9._-]*', project) is not None)
    namespaces = ('runs', 'repos', 'worktrees', 'builds')
    return ([(root / name, 0 if name in (*namespaces, 'locks', 'libexec') else account.pw_uid,
              0o750 if name in (*namespaces, 'locks', 'libexec') else 0o700, True)
             for name in (*namespaces, 'cache', 'generated', 'evidence', 'temporary', 'locks', 'libexec')]
            + [(root / name / project, account.pw_uid, 0o700, True) for name in namespaces])


def layout(account, root):
    native = runpy.run_path(str(Path(__file__).with_name('worker-primitives.py')))
    entries = directories(account, root)
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


def preflight(config, system='Darwin'):
    require(platform.system() == system and system in ('Darwin', 'Linux') and os.geteuid() == 0)
    require(system != 'Darwin' or platform.machine() == 'arm64')
    require(re.fullmatch(r'[a-z_][a-z0-9_-]*', config['account']) is not None)
    account = pwd.getpwnam(config['account'])
    require(account.pw_uid == config['uid'] and account.pw_uid > 0)
    require(set(os.getgrouplist(account.pw_name, account.pw_gid)) == {account.pw_gid})
    native = runpy.run_path(str(Path(__file__).with_name('worker-primitives.py')))
    native['isolation_account'](config)
    # HOME is obtained from directory services, never inherited from the controller.
    home = Path(account.pw_dir)
    protected(home)
    os.close(native['isolation_directory'](str(home), 0, account.pw_gid, 0o750, True))
    require(trusted_json(home / '.cardigan-project', 0o644) == {'project': config['project'], 'uid': account.pw_uid})
    denial = subprocess.run(['/usr/bin/sudo', '-n', '-l', '-U', account.pw_name],
                            capture_output=True, text=True, timeout=config['timeout_ms'] / 1000,
                            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    require(denial.returncode in (0, 1) and 'is not allowed to run sudo' in denial.stdout + denial.stderr)
    root, mount = Path(config['root']), Path(config['mount'])
    protected(root)
    os.close(native['isolation_directory'](str(root), 0, account.pw_gid, 0o750, True))
    require(root != home and root not in home.parents and home not in root.parents)
    require(len(root.parts) >= 3 and root != mount)
    require(mount == mount.resolve() and os.path.ismount(mount) and root.is_relative_to(mount))
    require(str(os.statvfs(mount).f_fsid) == config['volume'] and root.stat().st_dev == mount.stat().st_dev)
    for path, key in [(Path('/'), 'root'), (root, 'work')]:
        minimum = config['minimum_free_bytes'][key]
        require(type(minimum) is int and minimum > 0)
        space = os.statvfs(path)
        require(space.f_bavail * space.f_frsize >= minimum)
    marker = root / '.cardigan-worker'
    require(trusted_json(marker) == {'project': config['project'], 'uid': account.pw_uid, 'home': str(home)})
    layout(account, root)  # All existing conflicts are checked before the first mutation.
    return account, root


def apply(account, root):
    layout(account, root)
    for path, owner, mode, _ in directories(account, root):
        try:
            path.mkdir(mode=mode)
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fchmod(fd, mode)
                os.fchown(fd, owner, account.pw_gid)
            finally:
                os.close(fd)
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


def main(system='Darwin'):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--dry-run', action='store_true')
    modes.add_argument('--check', action='store_true')
    modes.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.dry_run:
        print(json.dumps({'platform': system.lower(), 'arch': 'arm64' if system == 'Darwin' else platform.machine(), 'hc': '0.1.18',
                          'steps': ['verify operator-prepared account and marker', 'verify mount, space and ACL',
                                    'create private worker directories', 'install protected helper and lock inodes'],
                          'manual': ['account', 'signed-app', 'tools', 'ssh', 'tcc', 'login']}))
        return
    config = trusted_json(Path(args.config))
    require(type(config.get('timeout_ms')) is int and 0 < config['timeout_ms'] <= 2147483647)
    account, root = preflight(config, system)
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
