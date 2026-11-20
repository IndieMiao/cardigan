"""Linux-only, fd-relative maintenance of generated resources. No shell or path from an Agent."""
import contextlib
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


def proc_refs():
    """Incomplete observation protects all releases, never treat lsof's empty stdout as proof."""
    with open('/proc/mounts') as f:
        require(any(x.split()[1:3] == ['/proc', 'proc'] and not re.search(r'hidepid=(?!0(?:,|$)|off(?:,|$))', x.split()[3]) for x in f))
    refs = set()
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        task = f'/proc/{pid}/task'
        try:
            tids = os.listdir(task)
        except FileNotFoundError:
            continue
        for tid in tids:
            t = f'{task}/{tid}'
            try:
                with open(t+'/stat') as file:
                    fields = file.read().rsplit(')', 1)[1].split()
                if fields[0] == 'Z' or int(fields[6]) & 0x200000:  # PF_KTHREAD
                    continue
                for link in ['cwd','root','exe'] + ['fd/'+f for f in os.listdir(t+'/fd')]:
                    try:
                        s = os.stat(t+'/'+link)
                    except FileNotFoundError:
                        if link.startswith('fd/'):
                            continue
                        raise
                    refs.add((s.st_dev, s.st_ino))
                # Device/inode also catches mappings whose fd was closed or whose path is an alias.
                with open(t+'/maps') as file:
                    for line in file:
                        _, _, _, dev, ino, *_ = line.split(None, 5)
                        if int(ino):
                            a,b = dev.split(':'); refs.add((os.makedev(int(a,16),int(b,16)),int(ino)))
            except (FileNotFoundError, ProcessLookupError):
                if os.path.exists(t):
                    raise ValueError('process_uncertain')
    return refs


def tree(fd, *, run, refs, remove=False, check=lambda: None):
    """Never traverse links, submounts (including same-device binds) or embedded run checkouts."""
    digest = hashlib.sha256()
    if run: digest.update(str(os.fstat(fd).st_ctime_ns).encode())
    def visit(d, guard):
        s = os.fstat(d)
        require((s.st_dev,s.st_ino) not in refs)
        names = sorted(os.listdir(d))
        if run:
            require('.git' not in names and not {'HEAD','objects','refs'}.issubset(names))
        total = s.st_blocks * 512
        for name in names:
            guard()
            with opened(name, os.O_PATH | os.O_NOFOLLOW, d) as handle:
                same(d,name,handle)
                st = os.fstat(handle)
                require((st.st_dev,st.st_ino) not in refs)
                digest.update(repr((os.fsencode(name),st.st_dev,st.st_ino,st.st_ctime_ns,st.st_size)).encode())
                if stat.S_ISDIR(st.st_mode):
                    with opened(name, DIR, d) as child:
                        require(identity(st) == identity(os.fstat(child)))
                        def bound():
                            guard(); same(d,name,child)
                        total += visit(child,bound)
                else:
                    total += st.st_blocks * 512
                if remove:
                    guard(); same(d,name,handle)
                    if stat.S_ISDIR(st.st_mode): os.rmdir(name,dir_fd=d)
                    else: os.unlink(name,dir_fd=d)
        return total
    size = visit(fd,check)
    return size, digest.hexdigest()


def entry(kind,name,fd,size,digest):
    st = os.fstat(fd)
    return dict(kind=kind,name=name,device=str(st.st_dev),inode=str(st.st_ino),size_bytes=size,stamp=digest)


def generated(root, pattern):
    items = []
    for name in os.listdir(root):
        if pattern.fullmatch(name):
            st = os.stat(name,dir_fd=root,follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077:
                items.append((st.st_mtime_ns,name))
    return [name for _,name in sorted(items,reverse=True)]


def releases(req,root):
    kept = set(req['keep'])
    names = generated(root,RELEASE)[req['latest']:]
    names = [n for n in names if n not in kept]
    if 'names' in req:
        requested = req['names']; require(len(requested) == 1 and RELEASE.fullmatch(requested[0]))
        names = [n for n in names if n == requested[0]]
    if 'item' in req:
        names = [n for n in names if n == req['item']['name']]; require(len(names)==1)
    result = {'candidates':[], 'skipped':[]}
    if not names: return result
    try: refs = proc_refs()
    except (OSError,ValueError,StopIteration):
        result['skipped'] = names; return result
    for name in names:
        try:
            with opened(name,DIR,root) as fd:
                def guard(): same(root,name,fd)
                guard()
                size, digest = tree(fd,run=False,refs=refs)
                item = entry('release',name,fd,size,digest)
                if 'item' in req:
                    require(item == req['item']); guard()
                    # Detach the old public name before the final process observation. An opener
                    # racing the rename is now observable by inode; no new open via the old name.
                    staged = '.retiring-' + name
                    require(staged not in os.listdir(root))
                    os.rename(name,staged,src_dir_fd=root,dst_dir_fd=root)
                    def fenced(): same(root,staged,fd)
                    try:
                        fenced()
                        refs = proc_refs()
                        size, digest = tree(fd,run=False,refs=refs)
                        require(entry('release',name,fd,size,digest)==item)
                        tree(fd,run=False,refs=refs,remove=True,check=fenced)
                        fenced(); os.rmdir(staged,dir_fd=root)
                    except BaseException:
                        # Do not overwrite a reused name; a crash leaves the staged directory
                        # outside automatic discovery for a host operator to reconcile.
                        if name not in os.listdir(root):
                            fenced(); os.rename(staged,name,src_dir_fd=root,dst_dir_fd=root)
                        raise
                result['candidates'].append(item)
        except (OSError,ValueError): result['skipped'].append(name)
    return result


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
                        size,digest=tree(fd,run=True,refs=set())
                        item=entry('run',name,fd,size,digest)
                        if op=='clear':
                            require(req['item']==item); guard()
                            tree(fd,run=True,refs=set(),remove=True,check=guard)
                    result['candidates'].append(item)
            except FileNotFoundError:
                if op!='inventory': result['skipped'].append(name)
            except (OSError,ValueError): result['skipped'].append(name)
    return result


def main(op,req):
    with anchor(req['root'],req['uid']) as root:
        if op in ('clear','shell','inventory'): return runs(req,root,op)
        st=os.fstat(root); require(st.st_uid==os.getuid()==req['uid'] and not st.st_mode & 0o077)
        if op=='releases': return releases(req,root)
        require(op=='snapshot')
        item=req['item']; name=item['name']; require(SNAP.fullmatch(name))
        with opened(name,os.O_PATH|os.O_NOFOLLOW,root) as fd:
            same(root,name,fd); st=os.fstat(fd)
            require(stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1 and st.st_uid==os.getuid() and identity(st)==[item['device'],item['inode']] and str(st.st_mtime_ns)==item['stamp'] and st.st_size==item['size_bytes'])
            os.unlink(name,dir_fd=root); return {'candidates':[item],'skipped':[]}


if __name__=='__main__':
    try:
        if sys.argv[1]=='clear': signal.alarm(4)  # An interrupted SSH session must not continue cleaning.
        print(json.dumps(main(sys.argv[1],json.load(sys.stdin)),separators=(',',':')))
    except Exception: sys.exit(1)  # Never export process, file or private error details.
