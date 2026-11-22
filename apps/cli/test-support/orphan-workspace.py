"""Exercise the worker Git operation in a disposable clone; no SSH or host files."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch


def git(path, *args):
    return subprocess.check_output(['git', '-C', path, *args], text=True).strip()


spec = importlib.util.spec_from_file_location('worker', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)
    repo, tree = base / 'repo', base / 'work'
    subprocess.run(['git', 'init', '-q', repo], check=True)
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base')
    git(repo, 'worktree', 'add', '-qb', 'agent/test', tree)
    (tree / 'mixed').write_text('staged')
    git(tree, 'add', 'mixed')
    (tree / 'mixed').write_text('working')
    (tree / 'new').write_bytes(b'\x00\xff')
    (tree / 'link').symlink_to('mixed')
    # Replace only the administrator-installed namespace and lock in the fixture.
    w = worker.Workspace.__new__(worker.Workspace)
    w.request = dict(operation='snapshot', assignment='A-1', branch='agent/test', generation='a' * 32,
                     repository=str(tree), timeout_ms=3000)
    w.project = 'fixture'
    w.repo, w.leaves = str(repo), [str(tree)]
    w.directory = lambda path: os.open(path, os.O_DIRECTORY | os.O_NOFOLLOW)
    w.lock = os.open(base / 'lock', os.O_CREAT | os.O_RDWR, 0o600)
    w.env = dict(PATH=os.environ['PATH'], HOME=tmp, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
    w.safety = ['-c', 'core.hooksPath=/dev/null']
    before = git(tree, 'status', '--porcelain=v1')
    try:
        if sys.argv[2:] in (['legacy'], ['snapshot-only']):
            if sys.argv[2:] == ['snapshot-only']:
                assert w.operate()
                w.request.update(operation='verify-sealed-snapshot')
            try:
                w.operate()
            except ValueError as error:
                assert str(error) == 'unsupported_operation'
            else:
                raise AssertionError('old helper unexpectedly accepted new operation')
            w.request.update(operation='git', args=['-C',str(tree),'rev-parse','HEAD'])
            assert w.operate().strip() == git(repo, 'rev-parse', 'HEAD')
        else:
            sha = w.operate()
            assert w.operate() == sha
            backup = 'refs/cardigan/backups/orphans/A-1/' + 'a' * 32
            central = base / 'central'
            subprocess.run(['git', 'init', '-q', '--bare', central], check=True)
            git(central, 'fetch', '-q', str(repo), backup + ':' + backup)
            assert git(central, 'rev-parse', backup) == sha
            assert git(central, 'show', sha + ':mixed') == 'working'
            assert git(central, 'show', sha + '^2:mixed') == 'staged'
            assert git(central, 'show', sha + ':link') == 'mixed'
            assert subprocess.check_output(['git', '-C', central, 'show', sha + ':new']) == b'\x00\xff'
            git(central, 'fsck', '--full')
            with (repo / '.git/info/exclude').open('a') as exclude:
                exclude.write('\nlocal-notes/\n')
            notes = tree / 'local-notes'
            notes.mkdir()
            (notes / 'draft.txt').write_text('private draft')
            try:
                w.operate()
            except ValueError:
                pass
            else:
                raise AssertionError('ignored user file considered backed up')
            assert (notes / 'draft.txt').read_text() == 'private draft'
            (notes / 'draft.txt').unlink()
            notes.rmdir()
            (tree / 'mixed').write_text('new work')
            try:
                w.operate()
            except ValueError:
                pass
            else:
                raise AssertionError('changed workspace considered backed up')
            assert git(repo, 'rev-parse', backup) == sha
            if sys.platform == 'linux':
                # An ordinary worker has no durable seal. Even the replicated
                # SHA and the real original process can never substitute for it.
                generation = 'b' * 32
                w.request.update(operation='snapshot', generation=generation)
                (tree / 'link').unlink()
                before = git(tree, 'status', '--porcelain=v1')
                sha = w.operate()
                w.request.update(operation='verify-sealed-snapshot', expected=sha,
                                 process=worker.native.identity('fixture', os.getpid(), generation, os.getpgrp()))
                w.root = tmp
                assert w.operate() is None
                # Drive the complete traversal with synthetic kernel flags,
                # keeping real worktree/index/ref reads and byte comparisons.
                # The server fixture separately exercises actual kernel write denial.
                mount = worker.mount_id(w.lock)
                def verify(_w, _path):
                    worker.verify_storage_seals(w, str(tree), {mount: 'ext4'})
                    return True
                with patch.object(worker, 'durable_writer_fence', verify), \
                        patch.object(worker, 'inode_flags', return_value=0x100010):
                    assert w.operate() == sha
                    victim = (tree / 'mixed').stat().st_ino
                    with patch.object(worker, 'inode_flags', side_effect=lambda fd:
                            0x10 if os.fstat(fd).st_ino == victim else 0x100010):
                        try:
                            w.operate()
                        except ValueError:
                            pass
                        else:
                            raise AssertionError('immutable alone passed as verity')
                    (tree / 'mixed').write_text('changed')
                    try:
                        w.operate()
                    except ValueError:
                        pass
                    else:
                        raise AssertionError('seal accepted different working bytes')
        assert git(tree, 'status', '--porcelain=v1') == before
    finally:
        os.close(w.lock)
        os.chdir(base.parent)
