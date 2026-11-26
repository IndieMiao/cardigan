"""C-746: the read-only explanation repeats the owner's proofs in order and
names only the first that fails. No real worker, core or process is touched."""
import importlib.util
import os
import runpy
import tempfile
from pathlib import Path

deploy = Path(__file__).resolve().parents[3] / 'deploy'
explain = runpy.run_path(str(deploy / 'darwin-idle-explain.py'))['explain']
spec = importlib.util.spec_from_file_location('inspection', deploy / 'inspect-worker.py')
real = importlib.util.module_from_spec(spec)
spec.loader.exec_module(real)
owner_source = runpy.run_path(str(deploy / 'darwin-idle-owner.py'), run_name='worker_idle_owner')
assert callable(owner_source['workspace'])  # the shipped owner exposes its proof without starting

start = os.getcwd()
with tempfile.TemporaryDirectory() as raw:
    root = Path(raw).resolve()
    tree = root / 'worktrees/fixture/A-1'
    tree.mkdir(parents=True)
    c = dict(platform='darwin', require_idle=True, project='fixture', assignment='A-1', root=str(root), generation='g1')
    seen = []

    def owner(workspace):
        def check(conf):
            seen.append(('workspace', conf['worktree'], conf['cwd'], os.getcwd()))
            return workspace
        return dict(workspace=check)

    def inspector(answer=None, why=None, error=None):
        def darwin_retirement(conf, terminal_owner, out):
            # The owner's proof without an owner PID: the parentage path.
            assert terminal_owner is None and conf['require_idle'] is True
            if error:
                raise error
            if why:
                out.append(why)
            return answer
        return dict(darwin_retirement=darwin_retirement, unavailable=real.unavailable)

    # The checkout is checked first, from the owner's own working directory.
    assert explain(inspector('alive'), owner('worktree_dirty'), c) == 'worktree_dirty'
    assert seen[-1] == ('workspace', 'write', str(tree), str(tree))
    assert explain(inspector('unknown', 'terminal_not_idle'), owner(None), c) == 'terminal_not_idle'
    assert explain(inspector('unknown', 'terminal_owner_mismatch'), owner(None), c) == 'terminal_owner_mismatch'
    assert explain(inspector('kept'), owner(None), c) == 'terminal_kept'
    assert explain(inspector(error=real.Unavailable('core_error')), owner(None), c) == 'core_error'
    assert explain(inspector(error=FileNotFoundError('/private')), owner(None), c) == 'core_socket_missing'
    # A refused binding check is not reported as a core reply.
    assert explain(inspector(error=ValueError()), owner(None), c) == 'terminal_unreadable'
    # Every proof passes now: nothing to name.
    assert explain(inspector('alive'), owner(None), c) is None
    # A session without a worktree runs in its generation directory.
    tree.rmdir()
    generation = root / 'runs/fixture/A-1/generations/g1'
    generation.mkdir(parents=True)
    assert explain(inspector('alive'), owner(None), c) is None
    assert seen[-1] == ('workspace', 'none', str(generation), str(generation))
    generation.rmdir()
    assert explain(inspector('alive'), owner(None), c) == 'workspace_cwd'
    # Never for a non-Darwin or non-idle binding.
    for wrong in (dict(c, platform='linux'), dict(c, require_idle=False)):
        try:
            explain(inspector('alive'), owner(None), wrong)
            raise AssertionError('unexpected binding accepted')
        except ValueError:
            pass
    os.chdir(start)
