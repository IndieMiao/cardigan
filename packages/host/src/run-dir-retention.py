"""C-743: remove released Assignments' run directories. Shipped inline (python3 -c).

Input (stdin JSON): {"root": "<abs>/runs/<project>", "names": ["A-1", ...],
"budget_ms": n, "preview": bool}. The host chose every name; this process only
accepts Assignment-shaped names directly under the fixed root. Never follows a
symlink, never leaves the root's file system, prints only names and counts.
"""
import json
import os
import re
import stat
import sys
import time

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
NAME = re.compile(r'A-[1-9][0-9]*')


class OutOfTime(Exception):
    pass


def require(ok):
    if not ok:
        raise ValueError('rejected')


def walk(path):
    require(type(path) is str and os.path.isabs(path) and os.path.normpath(path) == path and path != '/')
    fd = os.open('/', DIR)
    try:
        for part in path.split('/')[1:]:
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


class Pass:
    def __init__(self, dev, deadline, preview):
        self.dev, self.deadline, self.preview = dev, deadline, preview
        self.partial = False

    def tick(self):
        if time.monotonic() > self.deadline:
            raise OutOfTime()

    def clear(self, fd):
        """Remove everything inside the open directory; return bytes freed."""
        freed = 0
        with os.scandir(fd) as entries:
            names = [e.name for e in entries]
        for name in names:
            self.tick()
            try:
                st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            try:
                if stat.S_ISDIR(st.st_mode):
                    if st.st_dev != self.dev:
                        self.partial = True  # A mount point is never ours to empty.
                        continue
                    child = os.open(name, DIR, dir_fd=fd)
                    try:
                        cst = os.fstat(child)
                        require((cst.st_dev, cst.st_ino) == (st.st_dev, st.st_ino))
                        if not self.preview and cst.st_uid == os.getuid() and stat.S_IMODE(cst.st_mode) & 0o700 != 0o700:
                            os.fchmod(child, stat.S_IMODE(cst.st_mode) | 0o700)  # Read-only caches.
                        freed += self.clear(child)
                    finally:
                        os.close(child)
                    if not self.preview:
                        os.rmdir(name, dir_fd=fd)
                    freed += st.st_blocks * 512
                else:
                    if not self.preview:
                        os.unlink(name, dir_fd=fd)
                    if st.st_nlink <= 1:
                        freed += st.st_blocks * 512
            except OutOfTime:
                raise
            except (OSError, ValueError):
                self.partial = True  # Another account's entry; the other pass or next round.
        return freed


def main(req):
    require(type(req) is dict and type(req.get('names')) is list and len(req['names']) <= 100000)
    require(all(type(n) is str and NAME.fullmatch(n) for n in req['names']))
    budget = req.get('budget_ms', 60000)
    require(type(budget) is int and 0 < budget <= 600000)
    preview = req.get('preview', False) is True
    deadline = time.monotonic() + budget / 1000
    results, complete = [], True
    try:
        root = walk(req['root'])
    except FileNotFoundError:
        return {'results': [], 'complete': True}
    try:
        rst = os.fstat(root)
        present = set(os.listdir(root))
        for name in sorted(set(req['names']) & present, key=lambda n: int(n[2:])):
            if time.monotonic() > deadline:
                complete = False
                break
            try:
                st = os.stat(name, dir_fd=root, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(st.st_mode) or st.st_dev != rst.st_dev:
                results.append({'name': name, 'state': 'skipped', 'freed_bytes': 0})
                continue
            work = Pass(rst.st_dev, deadline, preview)
            freed, state = 0, 'removed'
            try:
                fd = os.open(name, DIR, dir_fd=root)
                try:
                    fst = os.fstat(fd)
                    require((fst.st_dev, fst.st_ino) == (st.st_dev, st.st_ino))
                    freed = work.clear(fd)
                finally:
                    os.close(fd)
                if preview:
                    state = 'preview'
                elif work.partial:
                    state = 'partial'
                else:
                    try:
                        os.rmdir(name, dir_fd=root)
                        freed += st.st_blocks * 512
                    except OSError:
                        state = 'emptied'  # The leaf belongs to the host account.
            except OutOfTime:
                state, complete = 'partial', False
            except (OSError, ValueError):
                state = 'partial'
            results.append({'name': name, 'state': state, 'freed_bytes': freed})
            if not complete:
                break
    finally:
        os.close(root)
    return {'results': results, 'complete': complete}


if __name__ == '__main__':
    try:
        print(json.dumps(main(json.load(sys.stdin)), separators=(',', ':')))
    except Exception:
        sys.exit(1)  # Never export paths, file names inside runs, or error details.
