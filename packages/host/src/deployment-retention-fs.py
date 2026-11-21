"""Linux-only, fd-relative maintenance of generated resources. No shell or path from an Agent."""
import contextlib
import ctypes
import secrets
import hashlib
import json
import os
import re
import stat
import signal
import sys
import time

UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
RELEASE = re.compile(f'release-[a-f0-9]{{40}}-{UUID}')
SNAP = re.compile(f'database-{UUID}\\.bak')
ASSIGN = re.compile(r'A-[1-9][0-9]*')
DIR = os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW


def require(ok):
    if not ok:
        raise ValueError('unverified')


@contextlib.contextmanager
def opened(name, flags, parent=None):
    fd = os.open(name, flags, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


def mount(fd):
    with open(f'/proc/self/fdinfo/{fd}') as file:
        return next(x for x in file if x.startswith('mnt_id:')).strip()


def identity(s):
    return [str(s.st_dev), str(s.st_ino)]


def same(parent, name, fd):
    require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == identity(os.fstat(fd)))
    require(mount(fd) == mount(parent))


@contextlib.contextmanager
def anchor(path, uid):
    require(os.path.isabs(path) and os.path.normpath(path) == path and path != '/')
    with contextlib.ExitStack() as stack:
        fd = stack.enter_context(opened('/', DIR))
        for name in path.split('/')[1:]:
            fd = stack.enter_context(opened(name, DIR, fd))
            s = os.fstat(fd)
            require(s.st_uid in (0, uid) and (not s.st_mode & 0o022 or (s.st_uid == 0 and s.st_mode & stat.S_ISVTX)))
        yield fd


STAGED = '.retention-claim-'


def facts(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def observe(fd, guard, run):
    # The local plan (never exported) and the digest describe exactly the same entries.
    digest = hashlib.sha256()
    def visit(d):
        guard()
        before = facts(os.fstat(d))
        digest.update(repr(before).encode())
        names = sorted(os.listdir(d))
        if run:
            require('.git' not in names and not {'HEAD','objects','refs'}.issubset(names))
            require(not any(n.startswith(STAGED) for n in names))
        total = os.fstat(d).st_blocks * 512
        entries = {}
        for name in names:
            guard()
            with opened(name, os.O_PATH | os.O_NOFOLLOW, d) as handle:
                same(d,name,handle)
                st = os.fstat(handle)
                digest.update(repr((os.fsencode(name),facts(st))).encode())
                nested = None
                if stat.S_ISDIR(st.st_mode):
                    with opened(name, DIR, d) as child:
                        require(facts(os.fstat(child)) == facts(st))
                        size, nested = visit(child)
                        total += size
                else:
                    total += st.st_blocks * 512
                if run: entries[name] = (facts(st), nested)
                same(d,name,handle); require(facts(os.fstat(handle)) == facts(st))
        require(facts(os.fstat(d)) == before)
        digest.update(b'/')
        return total, entries
    size, entries = visit(fd)
    return size, digest.hexdigest(), entries


def rename_new(d, src, dst):
    # Atomic no-replace in both directions. No path-based fallback on older kernels.
    ret = ctypes.CDLL(None,use_errno=True).renameat2(d, os.fsencode(src), d, os.fsencode(dst), 1)
    if ret: raise OSError(ctypes.get_errno(), 'claim failed')


def discard(d, name, fd, expected, directory, guard):
    guard(); same(d,name,fd); require(facts(os.fstat(fd)) == expected)
    # A replacement between stat and rename must not be unlinked. Claim under a private
    # random name, confirm against the still-held original fd, restore without overwrite on error.
    claim = STAGED + secrets.token_hex(16)
    rename_new(d,name,claim)
    try:
        guard(); same(d,claim,fd)
        require(facts(os.fstat(fd))[:-1] == expected[:-1])  # rename changes ctime
        if directory: os.rmdir(claim,dir_fd=d)
        else: os.unlink(claim,dir_fd=d)
    except BaseException:
        rename_new(d,claim,name)
        raise


def clear_plan(d, entries, guard):
    guard(); require(set(os.listdir(d)) == set(entries))
    for name, (expected, nested) in entries.items():
        with opened(name, DIR if nested is not None else os.O_PATH | os.O_NOFOLLOW, d) as child:
            def bound():
                guard(); same(d,name,child)
            bound(); require(facts(os.fstat(child)) == expected)
            if nested is not None:
                clear_plan(child, nested, bound)
                require(not os.listdir(child))
                expected = facts(os.fstat(child))  # our removals changed this directory's times
            discard(d,name,child,expected,nested is not None,guard)
    guard(); require(not os.listdir(d))


def entry(kind,name,fd,size,digest):
    st = os.fstat(fd)
    return dict(kind=kind,name=name,device=str(st.st_dev),inode=str(st.st_ino),size_bytes=size,stamp=digest)


def release_inventory(req,root):
    # Q-979: this operation only reports observations. There is no release mutator.
    names=req['names']; require(len(names)==1 and RELEASE.fullmatch(names[0]) and 'item' not in req)
    name=names[0]
    with opened(name,DIR,root) as fd:
        def guard():
            same(root,name,fd); st=os.fstat(fd); require(st.st_uid==req['uid'] and not st.st_mode & 0o077)
        size,digest,_=observe(fd,guard,False)
        guard(); return {'candidates':[entry('release',name,fd,size,digest)],'skipped':[]}


def runs(req,root,op):
    uid, gid = req['uid'],req['gid']
    def perms(fd,mode):
        s=os.fstat(fd); require(s.st_uid==uid and s.st_gid==gid and stat.S_IMODE(s.st_mode)==mode)
    agent = os.getuid() not in (0,uid) and gid in [os.getgid(),*os.getgroups()]
    require((op in ('inventory','clear') and agent) or (op=='shell' and os.getuid()==uid))
    perms(root,0o2750)
    result={'candidates':[], 'skipped':[]}
    with opened('runs',DIR,root) as area, opened('cardigan',DIR,area) as parent:
        for fd in [area,parent]: perms(fd,0o2750)
        same(root,'runs',area); same(area,'cardigan',parent)
        for name in req['names']:
            require(ASSIGN.fullmatch(name))
            try:
                with opened(name,DIR,parent) as fd:
                    def guard():
                        if op=='clear': require(time.time_ns() // 1_000_000 < req['deadline_ms'])
                        same(root,'runs',area); same(area,'cardigan',parent); same(parent,name,fd); perms(fd,0o2770)
                    guard()
                    if op=='shell':
                        item=req['item']; require(identity(os.fstat(fd))==[item['device'],item['inode']] and not os.listdir(fd)); guard()
                        os.rmdir(name,dir_fd=parent)  # Q-970: no recursive fallback, even on ENOTEMPTY.
                    else:
                        size,digest,plan=observe(fd,guard,True)
                        item=entry('run',name,fd,size,digest)
                        if op=='clear':
                            require(req['item']==item); guard()
                            clear_plan(fd,plan,guard)
                    result['candidates'].append(item)
            except FileNotFoundError:
                result['skipped'].append(name)
            except (OSError,ValueError): result['skipped'].append(name)
    return result


def main(op,req):
    with anchor(req['root'],req['uid']) as root:
        if op in ('clear','shell','inventory'): return runs(req,root,op)
        st=os.fstat(root); require(st.st_uid==os.getuid()==req['uid'] and not st.st_mode & 0o077)
        if op=='release_inventory': return release_inventory(req,root)
        require(op=='snapshot')
        item=req['item']; name=item['name']; require(SNAP.fullmatch(name))
        with opened(name,os.O_PATH|os.O_NOFOLLOW,root) as fd:
            same(root,name,fd); st=os.fstat(fd)
            require(stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1 and st.st_uid==os.getuid() and identity(st)==[item['device'],item['inode']] and hashlib.sha256(f'{st.st_dev}:{st.st_ino}:{st.st_size}:{st.st_mtime_ns}:{st.st_ctime_ns}'.encode()).hexdigest()==item['stamp'] and st.st_size==item['size_bytes'])
            os.unlink(name,dir_fd=root); return {'candidates':[item],'skipped':[]}


if __name__=='__main__':
    try:
        if sys.argv[1]=='clear': signal.alarm(2)  # An interrupted SSH session must not continue cleaning.
        print(json.dumps(main(sys.argv[1],json.load(sys.stdin)),separators=(',',':')))
    except Exception: sys.exit(1)  # Never export process, file or private error details.
