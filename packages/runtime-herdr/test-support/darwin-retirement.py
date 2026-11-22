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
    # Claude Code and Codex never self-report: hc keeps status null for the
    # whole session. Only the client's own empty prompt on the same, unchanged
    # terminal record proves idle; a turn still running keeps the session.
    claude_idle = 'done\n' + '─' * 20 + '\n❯ \n' + '─' * 20 + '\n  ? for shortcuts\n'
    codex_idle = '• done\n\n› \n\n  100% context left\n'
    screens = {
        claude_idle: 'alive',
        codex_idle: 'alive',
        '✻ Working… (3s · esc to interrupt)\n' + claude_idle: 'unknown',  # old turn still running
        '• Working (5s • esc to interrupt)\n' + codex_idle: 'unknown',
        claude_idle.replace('❯ ', '❯ fix it'): 'unknown',  # a draft is not an empty editor
        codex_idle.replace('› ', '❯ '): 'unknown',  # prompt and footer of different clients
        'Do you want to proceed?\n  press enter to confirm\n' + claude_idle: 'unknown',
        '': 'unknown',
        'x' * 70000 + claude_idle: 'unknown',
    }
    saved, quiet = rpc, dict(t, status=None, turn=3)
    shown, record, calls = [claude_idle], [quiet], []
    def core(method, params):
        assert params['terminal'] == c['terminal']
        calls.append(method)
        if method == 'terminal.read':
            assert params['lines'] == 0
            return {'text': shown.pop(0) if len(shown) > 1 else shown[0]}
        return dict(record.pop(0) if len(record) > 1 else record[0])
    rpc = Mock(side_effect=core)
    settle = stack.enter_context(patch.object(worker.time, 'sleep', side_effect=lambda _: calls.append('sleep')))
    for screen, expected in screens.items():
        shown[:] = [screen]
        assert observe() == expected, (screen[-60:], expected)
    shown[:] = [claude_idle]
    for changed in (dict(turn=4), dict(status={'state': 'working'}), dict(pid=43), dict(foreground={'pid': 43}),
                    dict(created_ms=2)):
        record[:] = [quiet, {**quiet, **changed}]
        assert observe() == 'unknown', changed
    record[:] = [quiet]
    busy = '✻ Working… (3s · esc to interrupt)\n' + claude_idle
    # V-2993: the idle snapshot was taken, then the old turn redrew the screen
    # busy before the record was re-read; status, turn and PIDs never changed.
    shown[:] = [claude_idle, busy]
    assert observe() == 'unknown'
    # Two idle-looking screens that differ: something is still drawing.
    shown[:] = [claude_idle, 'more output\n' + claude_idle]
    assert observe() == 'unknown'
    shown[:] = [None]
    assert observe() == 'unknown'  # an invalid read never passes
    # The owner's own final check: get, read, wait, get, read; the last read
    # is the last observation before TERM.
    c.update(agent_name='cli', cwd='/fixture/tree')
    owned = dict(quiet, name='cli', cwd='/fixture/tree', rm=False, foreground={'pid': 42})
    record[:] = [owned]
    shown[:] = [claude_idle, busy]
    calls.clear()
    assert worker.darwin_retirement(c, terminal_owner=42) == 'unknown'
    assert calls == ['terminal.get', 'terminal.read', 'sleep', 'terminal.get', 'terminal.read'], calls
    shown[:] = [codex_idle]
    calls.clear()
    assert worker.darwin_retirement(c, terminal_owner=42) == 'alive'
    assert calls == ['terminal.get', 'terminal.read', 'sleep', 'terminal.get', 'terminal.read'], calls
    settle.assert_called_with(worker.SETTLE_SECONDS)
    assert worker.SETTLE_SECONDS > 1
    record[:] = [quiet]
    shown[:] = [claude_idle]
    c['require_idle'] = False
    rpc.reset_mock()
    assert observe() == 'alive'
    assert all(call.args[0] == 'terminal.get' for call in rpc.call_args_list)
    c['require_idle'] = True
    rpc = saved
    # A reported status must be a well-formed idle report.
    for status, expected in ((False, 'unknown'), ([], 'unknown'), ('idle', 'unknown'), ({}, 'unknown'),
                             ({'state': 'unknown'}, 'unknown'), ({'state': 'done'}, 'alive'),
                             ({'state': 'working'}, 'unknown'), ({'state': 'blocked'}, 'unknown'),
                             ({'state': 'error'}, 'unknown')):
        t['status'] = status
        assert observe() == expected, status
    t['status'] = {'state': 'idle'}
    rpc.reset_mock()
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
