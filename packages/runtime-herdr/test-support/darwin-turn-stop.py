"""C-626: the real collector and stop script against an isolated Darwin kernel/core model.

No socket, SSH or real signal: only the account, hc core reply, birth adapter
and os.kill are substituted.
"""
import contextlib
import importlib.util
import runpy
import signal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

deploy = Path(__file__).resolve().parents[3] / 'deploy'
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
worker = load('inspection', deploy / 'inspect-worker.py')
stopper = load('turn_stop', deploy / 'darwin-turn-stop.py')
p = dict(machine='binding', terminal='generation', uid=1234, pid=42, boot='boot', start='1:2', process_group=42)
c = dict(user='fixture', gid=1234, process=p, generation='generation', target='binding', session='fixture', terminal='t1',
         project='fixture', assignment='A-1', launch_run='R-1', primitive='installed-helper', require_idle=True, platform='darwin')
t = dict(address='t1', created_ms=1, pid=42, keep=False, state='live', status={'state': 'unknown'},
         labels=dict(cardigan='1', project='fixture', assignment='A-1', run='R-1', generation='generation'))
rpc = Mock(side_effect=lambda *_: t)
native = Mock(return_value=('boot', 1234, '1:2', 42))
with contextlib.ExitStack() as stack:
    for obj, name, value in [(worker.platform, 'system', 'Darwin'), (worker.os, 'getuid', 1234),
                             (worker.os, 'geteuid', 1234), (worker.os, 'getegid', 1234),
                             (worker.pwd, 'getpwuid', SimpleNamespace(pw_name='fixture', pw_gid=1234, pw_dir='/fixture'))]:
        stack.enter_context(patch.object(obj, name, return_value=value))
    stack.enter_context(patch.object(runpy, 'run_path', return_value={'darwin_identity': native}))
    stack.enter_context(patch.object(worker, 'core_rpc', side_effect=lambda *_: contextlib.nullcontext(rpc)))
    kill = stack.enter_context(patch.object(stopper.os, 'kill'))
    scope = vars(worker)
    run = lambda **extra: stopper.stop(scope, dict(c, **extra))

    # No reported activity: strict observation and the idle owner refuse.
    for activity in ('unknown', None):
        t['status'] = {'state': activity} if activity else {}
        assert worker.retirement_terminal(c) == 'unknown'
        assert run() == dict(result='refused')
    kill.assert_not_called()
    # Opted in after the bound empty editor: the same proof, then one TERM.
    assert worker.retirement_terminal(dict(c, unknown_activity=True)) == 'alive'
    assert run(unknown_activity=True) == dict(result='sent', pid=42)
    kill.assert_called_once_with(42, signal.SIGTERM)
    kill.reset_mock()
    # A reported turn is never treated as idle, even when opted in.
    for activity in ('working', 'blocked', 'error'):
        t['status'] = {'state': activity}
        assert run(unknown_activity=True) == dict(result='refused')
    # An hc idle status needs no opt-in.
    t['status'] = {'state': 'idle'}
    assert run() == dict(result='sent', pid=42)
    kill.reset_mock()
    # Kept shell, foreign label, other generation: never signalled.
    t['status'] = {'state': 'unknown'}
    for changed in (dict(keep=True), dict(labels=dict(t['labels'], assignment='A-2')),
                    dict(labels=dict(t['labels'], generation='other'))):
        saved = dict(t)
        t.update(changed)
        try:
            assert run(unknown_activity=True) == dict(result='refused')
        except ValueError:
            pass  # a foreign launch is rejected outright
        t.clear()
        t.update(saved)
    # PID reused (different birth) or another process group: refused at the last check.
    for birth in (('boot', 1234, '9:9', 42), ('boot', 1234, '1:2', 43)):
        native.side_effect = [('boot', 1234, '1:2', 42), birth]
        assert run(unknown_activity=True) == dict(result='refused')
    native.side_effect = None
    kill.assert_not_called()
    # Only an idle requirement and the Darwin platform are accepted.
    for bad in (dict(require_idle=False), dict(platform='linux')):
        try:
            run(unknown_activity=True, **bad)
            raise AssertionError('unbound stop accepted')
        except ValueError:
            pass
    kill.assert_not_called()
    # The owner's embedded inspector never opts in.
    assert 'unknown_activity' not in (deploy / 'darwin-idle-owner.py').read_text()
