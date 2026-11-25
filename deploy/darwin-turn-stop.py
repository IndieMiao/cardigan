"""Controller-shipped, single TERM for one system-ended turn on a macOS worker (C-626).

Used only when the generation's idle owner cannot be asked (not enrolled, or it
refuses because the retained checkout has changes or hc reports no activity).
Runs on the pinned worker account over the existing SSH transport, per call; it
is never installed. The caller supplies no signal, executable or target: the
only possible target is the host-enrolled CLI receipt, which the worker proves
again (labels, generation, parentage, boot and birth) immediately before TERM.
"""
import json
import os
import runpy
import signal
import sys


def stop(scope, c):
    p = c['process']
    if c.get('platform') != 'darwin' or c.get('require_idle') is not True:
        raise ValueError()
    # The same read-only proof the controller observed: labeled terminal of
    # this generation, live, not kept, idle (or no activity after the bound
    # empty editor), and the receipt's CLI as its direct child.
    if scope['darwin_retirement'](c) != 'alive':
        return dict(result='refused')
    native = runpy.run_path(c['primitive'])['darwin_identity']
    # Re-prove boot, birth, uid and process group last; never killpg.
    if scope['darwin_execution'](p, native) != 'alive':
        return dict(result='refused')
    os.kill(p['pid'], signal.SIGTERM)
    return dict(result='sent', pid=p['pid'])


if __name__ == '__main__':
    try:
        signal.alarm(10)
        inspector = {'__name__': 'worker_inspection'}
        exec(compile(sys.argv[1], '<worker-inspection>', 'exec'), inspector)
        print(json.dumps(stop(inspector, json.loads(sys.argv[2]))))
    except Exception:
        sys.exit(1)  # no tracebacks, hostnames, paths or raw output on failure
