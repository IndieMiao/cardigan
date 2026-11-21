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


CONFIG_DIR = {'Darwin': Path('/Library/Cardigan'), 'Linux': Path('/etc/cardigan')}
PROJECT = re.compile(r'[A-Za-z0-9_][A-Za-z0-9._-]*')


def binding_config(path):
    cfg = trusted_json(path)
    project = cfg['project']
    require(isinstance(project, str) and PROJECT.fullmatch(project))
    if path.name.startswith('worker-'):
        require(path.name == f'worker-{project}.json')
    return cfg


def binding_inventory(system):
    directory = CONFIG_DIR[system]
    protected(directory)
    for path in sorted(directory.iterdir()):
        if path.name != 'worker.json' and not re.fullmatch(r'worker-[A-Za-z0-9_][A-Za-z0-9._-]*\.json', path.name):
            continue
        try:
            cfg = binding_config(path)
        except (ValueError, KeyError, TypeError, OSError, RecursionError):
            cfg = None
        yield path, cfg


def select_binding(inventory, project):
    # Reserve even a malformed named config's filename. Never fall back to a
    # legacy binding of the same name when the requested config is ambiguous.
    matches = [(path, cfg) for path, cfg in inventory
               if path.name == f'worker-{project}.json' or cfg and cfg['project'] == project]
    require(len(matches) == 1 and matches[0][1] is not None)
    return matches[0]


def directories(account, root):
    project = trusted_json(root / '.cardigan-worker')['project']
    require(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9._-]*', project) is not None)
    namespaces = ('runs', 'repos', 'worktrees', 'builds')
    return ([(root / name, 0 if name in (*namespaces, 'locks', 'libexec') else account.pw_uid,
              0o750 if name in (*namespaces, 'locks', 'libexec') else 0o700, True)
             for name in (*namespaces, 'cache', 'generated', 'evidence', 'temporary', 'locks', 'libexec')]
            + [(root / name / project, account.pw_uid, 0o700, True) for name in namespaces])


def layout(account, root, expected_primitives=None):
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
            expected = b''
            if path.suffix != '.lock':
                expected = expected_primitives if expected_primitives is not None else Path(__file__).with_name('worker-primitives.py').read_bytes()
            require(path.read_bytes() == expected)
    return entries


def preflight(config, system='Darwin', expected_primitives=None):
    require(platform.system() == system and system in ('Darwin', 'Linux') and os.geteuid() == 0)
    require(system != 'Darwin' or platform.machine() == 'arm64')
    require(re.fullmatch(r'[a-z_][a-z0-9_-]*', config['account']) is not None)
    account = pwd.getpwnam(config['account'])
    require(account.pw_uid == config['uid'] and account.pw_uid > 0)
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
    require(root != home and root not in home.parents and home not in root.parents)
    require(len(root.parts) >= 3 and root != mount)
    require(mount == mount.resolve())
    root_fd = native['isolation_directory'](str(root), 0, account.pw_gid, 0o750, True)
    try:
        if system == 'Darwin':
            native['macos_check_directory'](home)
            native['macos_check_directory'](root)
            mount_fd = os.open(mount, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                require(not os.path.sameopenfile(root_fd, mount_fd))
                require(native['macos_on_volume'](root_fd, mount_fd, str(mount)))
            finally:
                os.close(mount_fd)
        else:
            require(root.is_relative_to(mount) and os.path.ismount(mount) and root.stat().st_dev == mount.stat().st_dev)
    finally:
        os.close(root_fd)
    require(str(os.statvfs(mount).f_fsid) == config['volume'])
    for path, key in [(Path('/'), 'root'), (root, 'work')]:
        minimum = config['minimum_free_bytes'][key]
        require(type(minimum) is int and minimum > 0)
        space = os.statvfs(path)
        require(space.f_bavail * space.f_frsize >= minimum)
    marker = root / '.cardigan-worker'
    require(trusted_json(marker) == {'project': config['project'], 'uid': account.pw_uid, 'home': str(home)})
    layout(account, root, expected_primitives)  # All existing conflicts are checked before the first mutation.
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
    target = parser.add_mutually_exclusive_group()
    target.add_argument('--config')
    target.add_argument('--project')
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--dry-run', action='store_true')
    modes.add_argument('--check', action='store_true')
    modes.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.dry_run:
        print(json.dumps({'platform': system.lower(), 'arch': 'arm64' if system == 'Darwin' else platform.machine(), 'hc': json.loads(Path(__file__).with_name('hc-version.json').read_text())['version'],
                          'steps': ['verify operator-prepared account and marker', 'verify mount, space and ACL',
                                    'create private worker directories', 'install protected helper and lock inodes'],
                          'manual': ['account', 'signed-app', 'tools', 'ssh', 'tcc', 'login']}))
        return
    if args.config:
        path = Path(args.config)
        config = binding_config(path)
        if path.parent == CONFIG_DIR[system] and (path.name == 'worker.json' or path.name.startswith('worker-')):
            select_binding(binding_inventory(system), config['project'])
        install_binding(config, system, args.apply)
    elif args.project:
        _, config = select_binding(binding_inventory(system), args.project)
        install_binding(config, system, args.apply)
    else:
        require(args.check)  # No implicit bulk write.
        inventory = list(binding_inventory(system))
        failed = not inventory
        for path, cfg in inventory:
            try:
                require(cfg is not None)
                select_binding(inventory, cfg['project'])
                install_binding(cfg, system, False)
            except Exception:
                print(json.dumps({'config': path.name, 'installation': 'failed'}))
                failed = True
        require(not failed)


def install_binding(config, system, apply_changes):
    require(type(config.get('timeout_ms')) is int and 0 < config['timeout_ms'] <= 2147483647)
    account, root = preflight(config, system)
    if apply_changes:
        apply(account, root)
    print(json.dumps({'project': config['project'], 'installation': 'applied' if apply_changes else 'checked', 'uid': account.pw_uid,
                      'capabilities_verified': False, 'remote_enabled': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('worker_preflight_failed', file=sys.stderr)
        sys.exit(1)
