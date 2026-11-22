"""Exercise the real collector against an isolated Darwin kernel/core model."""
import contextlib
import importlib.util
import json
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('inspection', Path(__file__).resolve().parents[3] / 'deploy/inspect-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
p = dict(machine='binding', terminal='generation', uid=1234, pid=42, boot='boot', start='1:2', process_group=42)
c = dict(user='fixture', gid=1234, process=p, generation='generation', target='binding', session='fixture', terminal='t1',
         project='fixture', assignment='A-1', launch_run='R-1', primitive='installed-helper', require_idle=True, platform='darwin')
t = dict(address='t1', created_ms=1, pid=42, keep=False, state='live', status={'state':'idle'},
         labels=dict(cardigan='1', project='fixture', assignment='A-1', run='R-1', generation='generation'))
rpc = Mock(return_value=t)
native = Mock(return_value=('boot', 1234, '1:2', 42))
# The dispatcher fixture has one real terminal parent and one sleeping CLI child.
# Only the account/core and Darwin-vs-Linux birth adapter are substituted.
if len(sys.argv) == 2:
    q = json.loads(sys.argv[1])
    birth = runpy.run_path(str(Path(spec.origin).with_name('worker-primitives.py')))[
        'darwin_identity' if sys.platform == 'darwin' else 'linux_identity']
    def native(pid):
        boot, _, start, group = birth(pid)
        return boot, 1234, start, group
    if 'process' not in q:
        boot, uid, start, group = native(q['cli'])
        print(json.dumps(dict(pid=q['cli'], boot=boot, uid=uid, start=start, process_group=group,
                              machine=q['target'], terminal=q['generation'])))
        sys.exit(0)
    c.update({key:q[key] for key in ('process', 'assignment', 'project', 'terminal', 'launch_run', 'generation', 'target', 'agent_name')})
    t.update(pid=q['parent'], address=c['terminal'], name=c['agent_name'], rm=False, foreground={'pid':q['cli']},
             labels=dict(cardigan='1', project=c['project'], assignment=c['assignment'], run=c['launch_run'], generation=c['generation']))
with contextlib.ExitStack() as stack:
    for obj, name, value in [(worker.platform, 'system', 'Darwin'), (worker.os, 'getuid', 1234),
                             (worker.os, 'geteuid', 1234), (worker.os, 'getegid', 1234),
                             (worker.pwd, 'getpwuid', SimpleNamespace(pw_name='fixture', pw_gid=1234, pw_dir='/fixture'))]:
        stack.enter_context(patch.object(obj, name, return_value=value))
    stack.enter_context(patch.object(runpy, 'run_path', return_value={'darwin_identity': native}))
    stack.enter_context(patch.object(worker, 'core_rpc', side_effect=lambda *_: contextlib.nullcontext(rpc)))
    poll = stack.enter_context(patch.object(worker.os, 'kill'))
    observe = lambda: worker.retirement_terminal(c)
    if len(sys.argv) == 2:
        print(observe())
        sys.exit(0)
    assert observe() == 'alive'
    c['agent_name'] = 'cli'
    t.update(pid=41, name='cli', rm=False, foreground={'pid':42})
    with patch.object(worker.subprocess, 'check_output', return_value=b' 41\n') as ps:
        assert observe() == 'alive'
        ps.assert_called_once()
        birth = native.return_value
        native.side_effect = [birth, ('boot', 1234, 'different', 42)]
        assert observe() == 'unknown'  # birth changed across the parentage read
        native.side_effect = None
        for changed in (dict(created_ms=2), dict(labels={}), dict(pid=43), dict(foreground={'pid':43})):
            rpc.side_effect = [t, {**t, **changed}]
            assert observe() == 'unknown'
        rpc.side_effect = None
        ps.side_effect = PermissionError()
        assert observe() == 'unknown'
    t['pid'] = 42
    t['state'] = 'finished'
    assert observe() == 'unknown'  # terminal alone cannot reap the original CLI
    native.return_value = ('boot', 1234, '2:3', 42)  # PID was reused
    assert observe() == 'exited'
    t.update(state='live', keep=True)
    assert observe() == 'kept'  # the process exit did not end the retained shell
    t['keep'] = False
    assert observe() == 'unknown'
    poll.assert_not_called()
    t['state'] = 'finished'
    native.side_effect = ValueError('identity_unknown')
    poll.side_effect = PermissionError()
    assert observe() == 'unknown'
    poll.side_effect = ProcessLookupError()
    assert observe() == 'exited'
    assert all(call.args == (42, 0) for call in poll.call_args_list)
    t['labels']['generation'] = 'different'
    try:
        observe()
        raise AssertionError('foreign launch accepted')
    except ValueError:
        pass
    rpc.side_effect = TimeoutError()
    try:
        observe()
        raise AssertionError('timeout accepted')
    except TimeoutError:
        pass
    assert all(call.args == ('terminal.get', {'terminal': 't1'}) for call in rpc.call_args_list)
