/**
 * Executed by the configured worker Python in isolated mode. Darwin has no
 * /proc/self/fd. Walk from / using openat + NOFOLLOW on every component;
 * hand the verified descriptor (not a pathname to reopen) to the same Node
 * metadata parser as Linux. Neither the transcript nor stderr crosses stdout.
 */
export const WORKER_CLAUDE_OPENER = `
import contextlib, os, signal, stat, sys
signal.alarm(10)
root, session, parser = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
@contextlib.contextmanager
def directory(name, parent=None):
    fd = os.open(name, flags, dir_fd=parent)
    try: yield fd
    finally: os.close(fd)

def entries(fd):
    with os.scandir(fd) as it:
        for i, entry in enumerate(it):
            if i >= 2048: raise ValueError()
            yield entry

def read():
    with contextlib.ExitStack() as dirs:
        fd = dirs.enter_context(directory('/'))
        for part in (root + '/claude/projects').split('/'):
            if part:
                if part in ('.', '..'): raise ValueError()
                fd = dirs.enter_context(directory(part, fd))
        found = None
        for slug in entries(fd):
            if not slug.is_dir(follow_symlinks=False): continue
            with directory(slug.name, fd) as folder:
                for e in entries(folder):
                    if not e.name.endswith('.jsonl') or not e.is_file(follow_symlinks=False): continue
                    if session and e.name != session + '.jsonl': continue
                    # A generation normally contains a single CLI session. If
                    # ambiguous, do not guess based on a late write or mtime.
                    if found: return
                    file = os.open(e.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
                    dirs.callback(os.close, file)
                    st = os.fstat(file)
                    if not stat.S_ISREG(st.st_mode) or st.st_ino != e.inode(): raise ValueError()
                    found = (file, os.path.join(root, 'claude', 'projects', slug.name, e.name))
        if not found: return
        file, path = found
        os.dup2(file, 0, inheritable=True)
        os.execvp('node', ['node', '-e', parser, '--', path, session, 'worker-fd'])
try:
    read()
    print('null')
except FileNotFoundError:
    print('null')
except Exception:
    print('{"read_failed":true}')
`;
