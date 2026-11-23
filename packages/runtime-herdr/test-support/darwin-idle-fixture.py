"""Isolated terminal manager; signing, workspace, native birth, child and TERM are real.

With a third argument `real[:<screen>[:<state>]]` the owner runs inside an isolated
real hc terminal and reads that core's own terminal record and screen. The child
draws a client screen (`idle`: Claude Code's empty prompt; `busy`: the same with a
turn still running) and, with `<state>`, self-reports it over OSC 7501 the way
only status-reporting harnesses do."""
import contextlib
import importlib.util
import json
import os
import pwd
import runpy
import sys
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

source = Path(sys.argv[1]); owner = runpy.run_path(str(source)); c = json.loads(sys.argv[2]); root = Path(c['root'])
spec = importlib.util.spec_from_file_location('probe',source.with_name('inspect-worker.py'))
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
native = source.with_name('worker-primitives.py')
uid=os.getuid() or 1234  # Unprivileged synthetic account even under a root CI runner.
c.update(user='fixture', gid=1234, primitive=str(root/'native.py'))
(root/'native.py').write_text(f"import os,runpy\nbirth=runpy.run_path({str(native)!r})['darwin_identity' if os.uname().sysname=='Darwin' else 'linux_identity']\ndef darwin_identity(pid):\n b,_,s,g=birth(pid);return b,{uid},s,g")

IDLE = 'done\r\n' + '─' * 20 + '\r\n❯ \r\n' + '─' * 20 + '\r\n  ? for shortcuts'
# `ticking` keeps redrawing a line above an idle-looking prompt, like any
# client still drawing output: never two identical reads.
SCREENS = dict(idle=IDLE, busy='✻ Working… (3s · esc to interrupt)\r\n' + IDLE, ticking='tick {n}\r\n' + IDLE)

def rpc(method, params):
    if method == 'terminal.read':
        screen = (root/'screen').read_text() if (root/'screen').exists() else 'idle'
        # `malformed`: a core reply that is not an object (no `.get`).
        return ['malformed'] if screen == 'malformed' else dict(text=SCREENS[screen])
    assert method == 'terminal.get'
    state = (root/'state').read_text()
    return dict(address='t1', created_ms=1, pid=os.getpid(), name=c['agent_name'], cwd=c['cwd'],
                foreground=dict(pid=json.loads((root/'child').read_text())['pid']), rm=False, keep=False, state='live',
                # 'null': hc's record for Claude Code and Codex, which never self-report.
                status=None if state == 'null' else {'state':state}, labels=dict(cardigan='1',project=c['project'],assignment=c['assignment'],
                    run=c['launch_run'],generation=('next' if state=='replaced' else c['generation'])))

# Same identity primitive as the shipped worker launcher. Only the core and the
# platform selection are substituted on Linux; there is no production socket.
script = "import os,sys,runpy,json,time; from pathlib import Path; p=runpy.run_path(sys.argv[1])['identity'](sys.argv[2],os.getpid(),sys.argv[3],os.getpgrp()); p['uid']=int(sys.argv[5]);Path(sys.argv[4]).write_text(json.dumps(p)); sys.argv[7:] and print(f'\\x1b]7501;state={sys.argv[7]}\\x07', end='', flush=True); s=(sys.argv[6:] or [''])[0]; [(print('\\x1b[2J\\x1b[H'+s.replace('{n}',str(i)), end='', flush=True), time.sleep(0.4 if '{n}' in s else 20)) for i in range(50 if '{n}' in s else 1)]"
mode = sys.argv[3].split(':') if len(sys.argv) > 3 else ['']
real = mode[0] == 'real'
draw = [SCREENS[mode[1] if len(mode) > 1 else 'idle'], *mode[2:3]] if real else []
real_uid, real_rpc = os.getuid(), probe.core_rpc

@contextlib.contextmanager
def core(home, session, system):
    # The real core of this isolated hc session; its socket is passed to the terminal.
    with patch.object(probe, 'socket_path', return_value=Path(os.environ['HC_TERMINAL_SOCKET'])), \
            patch.object(os, 'getuid', return_value=real_uid):
        opened = real_rpc(home, session, system)
        rpc = opened.__enter__()
    try:
        yield rpc
    finally:
        opened.__exit__(None, None, None)

with patch.object(sys, 'platform', 'darwin'), patch.object(probe.platform, 'system', return_value='Darwin'), \
        patch.object(probe, 'core_rpc', side_effect=core if real else lambda *_: contextlib.nullcontext(rpc)), \
        patch.object(os,'getuid',return_value=uid), patch.object(os,'geteuid',return_value=uid), \
        patch.object(os,'getegid',return_value=1234), patch.object(pwd,'getpwuid',return_value=SimpleNamespace(pw_name='fixture',pw_gid=1234,pw_dir=str(root))):
    sys.exit(owner['supervise'](c, [sys.executable,'-IB','-c',script,str(native),c['target'],c['generation'],str(root/'child'),str(uid),*draw],probe.darwin_retirement))
