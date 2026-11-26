"""Controller-shipped, read-only explanation of one idle owner's refusal (C-746).

An owner enrolled before C-746 refuses a stop by closing its socket without a
word. Run per call on the pinned worker account over the existing SSH transport
(never installed), this repeats the owner's own proofs with the owner's own
code: the workspace check from darwin-idle-owner.py and the idle terminal proof
from inspect-worker.py. It sends no signal, writes nothing and changes no
terminal; it prints only the first failed proof as a bounded code (or null).
"""
import json
import os
import signal
import sys
from pathlib import Path


def explain(inspector, owner, c):
    if c.get('platform') != 'darwin' or c.get('require_idle') is not True:
        raise ValueError()
    leaf = Path(c['project'], c['assignment'])
    tree = Path(c['root'], 'worktrees', leaf)
    # The owner's working directory is its launch cwd: the assignment worktree,
    # or the generation directory of a session without one.
    worktree = 'write' if os.path.isdir(tree) else 'none'
    cwd = tree if worktree == 'write' else Path(c['root'], 'runs', leaf, 'generations', c['generation'])
    c = dict(c, worktree=worktree, cwd=str(cwd))
    try:
        os.chdir(cwd)
    except OSError:
        return 'workspace_cwd'
    refused = owner['workspace'](c)
    if refused:
        return refused
    why = []
    try:
        observed = inspector['darwin_retirement'](c, None, why)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        code = inspector['unavailable'](error)
        # A bare ValueError is a refused binding check, not a core reply.
        return 'terminal_unreadable' if code == 'core_reply_invalid' else code
    if observed != 'alive':
        return why[0] if why else 'terminal_' + observed
    return None


if __name__ == '__main__':
    try:
        signal.alarm(12)
        inspector = {'__name__': 'worker_inspection'}
        exec(compile(sys.argv[1], '<worker-inspection>', 'exec'), inspector)
        owner = {'__name__': 'worker_idle_owner'}
        exec(compile(sys.argv[2], '<idle-owner>', 'exec'), owner)
        print(json.dumps(dict(refused=explain(inspector, owner, json.loads(sys.argv[3])))))
    except Exception:
        sys.exit(1)  # no tracebacks, hostnames, paths or raw output on failure
