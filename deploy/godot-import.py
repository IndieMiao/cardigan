#!/usr/bin/env python3
"""Opt-in, unprivileged first import in a fresh macOS project worktree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

# The editor can probe Android even in headless mode. Do not rely on an adb
# client honoring its environment; cover direct socket calls and children too.
OFFLINE = ('(version 1)(allow default)(deny network*)'
           '(deny file-read* process-exec (regex #"/adb$"))')


def offline(engine, home):
    if sys.platform != 'darwin' or not engine.is_absolute() or not engine.is_file():
        raise ValueError('requires macOS and an absolute Godot executable')
    command = ['/usr/bin/sandbox-exec', '-p', OFFLINE, str(engine)]
    env = dict(HOME=home, PATH=os.defpath, TMPDIR=home,
               XDG_CACHE_HOME=home + '/cache', XDG_DATA_HOME=home + '/data',
               XDG_CONFIG_HOME=home + '/config', ADB_SERVER_SOCKET='localfilesystem:/dev/null',
               ANDROID_SERIAL='cardigan-unassigned')

    def run(*args, capture=False):
        return subprocess.run([*command, *args], env=env, check=True,
                              stdout=subprocess.PIPE if capture else None, text=True)
    return run


def worktree_key(root, run):
    def git(*args):
        return subprocess.check_output(['/usr/bin/git', '-c', 'core.fsmonitor=false', *args],
                                       cwd=root, text=True, env={
                                           'PATH': os.defpath, 'GIT_OPTIONAL_LOCKS': '0',
                                           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                                       }).rstrip('\n')
    # A primary checkout with --separate-git-dir also has a regular .git file.
    # Only a registered linked checkout has its own per-worktree metadata.
    git_dir = Path(git('rev-parse', '--absolute-git-dir')).resolve()
    common = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir')).resolve()
    if (git_dir.parent != common / 'worktrees' or (root / '.git').is_symlink()
            or root != Path(git('rev-parse', '--show-toplevel')) or not (root / '.git').is_file()
            or (root / 'project.godot').is_symlink() or not (root / 'project.godot').is_file()
            or git('status', '--porcelain', '--untracked-files=all', '--ignored=matching')
            or git('ls-files', '--', '.godot')):
        raise ValueError('requires a clean, fresh linked worktree with project.godot at its root')
    return {'schema': 1, 'head': git('rev-parse', '--verify', 'HEAD^{commit}'),
            'godot': run('--version', capture=True).stdout.strip(), 'arch': platform.machine()}


def digest(stream):
    h = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(block)
    return h.hexdigest()


def flat_name(name):
    return (name not in ('', '.', '..') and not any(c in name for c in ('/', '\\', ':', '\0')))


def pack(cache, snapshot, key):
    imported = cache / 'imported'
    if cache.is_symlink() or imported.is_symlink() or not imported.is_dir():
        raise ValueError('no imported assets to publish')
    # Create a staging artifact, not a live cache: publish separately only
    # after the producing job succeeds, reviews diagnostics and pins the hash.
    # Work in the destination filesystem, then publish without replacing any
    # existing name. No partially written file can occupy the requested path.
    with tempfile.NamedTemporaryFile(dir=snapshot.parent) as dst:
        with zipfile.ZipFile(dst, 'w', zipfile.ZIP_STORED) as archive:
            for f in sorted(imported.iterdir()):
                if not stat.S_ISREG(f.lstat().st_mode) or not flat_name(f.name):
                    raise ValueError('unsupported imported asset; do not publish')
                archive.write(f, f.name)
            if not archive.infolist():
                raise ValueError('empty import; do not publish')
            archive.comment = json.dumps(key).encode()
        dst.seek(0)
        sha = digest(dst)
        os.link(dst.name, snapshot)
        return sha


def restore(cache, snapshot, sha, key):
    imported = cache / 'imported'
    try:
        with snapshot.open('rb') as src:
            if digest(src) != sha:
                raise ValueError('digest mismatch')
            with zipfile.ZipFile(src) as archive:
                if json.loads(archive.comment) != key or not archive.infolist():
                    raise ValueError('incompatible seed')
                imported.mkdir()
                for entry in archive.infolist():
                    if not flat_name(entry.orig_filename) or entry.compress_type != zipfile.ZIP_STORED:
                        raise ValueError('unsupported seed entry')
                    # All destinations are new regular files; no archive paths,
                    # permissions, links or editor settings are installed.
                    with archive.open(entry) as data, (imported / entry.filename).open('xb') as dst:
                        shutil.copyfileobj(data, dst, 1024 * 1024)
        return True
    except (ValueError, OSError, RuntimeError, zipfile.BadZipFile):
        if imported.exists():
            shutil.rmtree(imported)
        print('seed unavailable or invalid: full import', file=sys.stderr)
        return False


def prepare(root, run, snapshot=None, sha=None, seed=False):
    if snapshot and (not snapshot.is_absolute() or root in snapshot.resolve().parents):
        raise ValueError('snapshot must be an absolute path outside the worktree')
    key = worktree_key(root, run)
    cache = root / '.godot'
    cache.mkdir(mode=0o700)  # Exclusive: never adopt or remove an existing cache.
    hit = not seed and snapshot is not None and restore(cache, snapshot, sha, key)
    args = ('--headless', '--path', str(root), '--import')
    try:
        run(*args)
    except subprocess.CalledProcessError:
        if not hit:
            raise
        print('seeded import failed: retrying one full import', file=sys.stderr)
        shutil.rmtree(cache)  # This invocation created it in a fresh, exclusive worktree.
        run(*args)
        hit = False
    if seed:
        print('snapshot_sha256=' + pack(cache, snapshot, key))
    print('import=' + ('restored' if hit else 'cold'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['seed', 'import'])
    parser.add_argument('--godot', required=True, type=Path)
    parser.add_argument('--snapshot', type=Path)
    parser.add_argument('--sha256')
    args = parser.parse_args()
    if args.mode == 'seed':
        if not args.snapshot or args.sha256:
            parser.error('seed needs --snapshot only')
    elif bool(args.snapshot) != bool(args.sha256) or (args.sha256 and not re.fullmatch('[0-9a-f]{64}', args.sha256)):
        parser.error('supply both --snapshot and a trusted --sha256, or neither')
    if os.geteuid() == 0:
        parser.error('never run the project importer as root')
    os.umask(0o077)
    with tempfile.TemporaryDirectory() as home:
        prepare(Path.cwd(), offline(args.godot, home), args.snapshot, args.sha256, args.mode == 'seed')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
