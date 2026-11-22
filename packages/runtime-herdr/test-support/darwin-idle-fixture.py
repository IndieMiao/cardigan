"""Isolated terminal manager; signing, workspace, native birth, child and TERM are real."""
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

def rpc(method, params):
    assert method == 'terminal.get'
    state = (root/'state').read_text()
    return dict(address='t1', created_ms=1, pid=os.getpid(), name=c['agent_name'], cwd=c['cwd'],
                foreground=dict(pid=json.loads((root/'child').read_text())['pid']), rm=False, keep=False, state='live',
                status={'state':state}, labels=dict(cardigan='1',project=c['project'],assignment=c['assignment'],
                    run=c['launch_run'],generation=('next' if state=='replaced' else c['generation'])))

# Same identity primitive as the shipped worker launcher. Only the core and the
# platform selection are substituted on Linux; there is no production socket.
script = "import os,sys,runpy,json,time; from pathlib import Path; p=runpy.run_path(sys.argv[1])['identity'](sys.argv[2],os.getpid(),sys.argv[3],os.getpgrp()); p['uid']=int(sys.argv[5]);Path(sys.argv[4]).write_text(json.dumps(p)); time.sleep(20)"
with patch.object(sys, 'platform', 'darwin'), patch.object(probe.platform, 'system', return_value='Darwin'), \
        patch.object(probe, 'core_rpc', side_effect=lambda *_: contextlib.nullcontext(rpc)), \
        patch.object(os,'getuid',return_value=uid), patch.object(os,'geteuid',return_value=uid), \
        patch.object(os,'getegid',return_value=1234), patch.object(pwd,'getpwuid',return_value=SimpleNamespace(pw_name='fixture',pw_gid=1234,pw_dir=str(root))):
    sys.exit(owner['supervise'](c, [sys.executable,'-IB','-c',script,str(native),c['target'],c['generation'],str(root/'child'),str(uid)],probe.darwin_retirement))
