"""Exercise the generated shell argv without sudo; keep every operator side effect mocked."""
from pathlib import Path
import json
import runpy
import shlex
import sys
import tempfile
from unittest.mock import Mock, patch

args = shlex.split(sys.argv[1]); _, python, isolated, flag, script, entry, system, project, user, root, directory = args
assert isolated == '-IB' and flag == '-c' and args[0] == 'sudo'
mac = system == 'Darwin'
assert python == ('/opt/homebrew/bin/python3' if mac else '/usr/bin/python3')
assert directory == ('/Library/Cardigan' if mac else '/etc/cardigan')
assert entry == '/opt/cardigan/deploy/install-' + ('macos' if mac else 'linux') + '-worker.py'
current = Path(__file__).resolve().parents[3] / 'deploy/install-macos-worker.py'
# Optional historical installation for the maintainer's mixed-version replay.
old = runpy.run_path(sys.argv[2] if len(sys.argv) > 2 else str(current))
if len(sys.argv) > 2: assert 'select_binding' not in old
old = {k:old[k] for k in ('trusted_json','require','preflight','apply','protected')}
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp); legacy = tmp / 'worker.json'; named = tmp / ('worker-' + project + '.json')
    cfg = dict(project=project,account=user,root=root,timeout_ms=50)
    def invoke(api):
        with patch.object(runpy, 'run_path', return_value=api) as load, patch.object(sys, 'argv', ['-c',entry,system,project,user,root,str(tmp)]):
            exec(script, {})
            load.assert_called_once_with('/opt/cardigan/deploy/install-macos-worker.py')
    # Old code's protected reader, account checks and apply perform privileged IO.
    # Replace them only after looking up the actual installed API.
    preflight = Mock(return_value=('account', 'target')); apply = Mock()
    old.update(protected=Mock(), trusted_json=lambda p:json.loads(p.read_text()), preflight=preflight, apply=apply)
    legacy.write_text(json.dumps(cfg)); invoke(old)
    old['protected'].assert_called_once_with(tmp); preflight.assert_called_once_with(cfg,system); apply.assert_called_once_with('account','target')
    for changed, extra in [({'project':'other'},False),({'account':'other'},False),({'root':'/other'},False),({},True),({'timeout_ms':0},False)]:
        legacy.write_text(json.dumps({**cfg,**changed})); preflight.reset_mock(); apply.reset_mock()
        if extra: named.write_text('{}')
        try: invoke(old)
        except ValueError: pass
        else: raise AssertionError('must refuse ambiguous or mismatched binding')
        named.unlink(missing_ok=True); preflight.assert_not_called(); apply.assert_not_called()
    with patch('subprocess.run') as call:
        invoke(runpy.run_path(str(current)))
        assert [c.args[0] for c in call.call_args_list] == [[sys.executable,'-IB',entry,'--project',project,f] for f in ('--check','--apply')]
        assert all(c.kwargs == {'check':True} for c in call.call_args_list)
