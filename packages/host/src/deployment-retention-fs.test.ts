import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Use real openat/stat/rmdir on temporary files. Only the process inventory and the
// simulated second uid are substituted (tests may not provision accounts or use sudo).
const file = fileURLToPath(
  new URL("./deployment-retention-fs.py", import.meta.url),
);
function fixture(body: string) {
  const setup = `import os,tempfile,runpy,sys,contextlib\nfrom pathlib import Path\nfrom unittest.mock import patch\nh=runpy.run_path(sys.argv[1]); main=h['main']; g=main.__globals__\nwith tempfile.TemporaryDirectory() as tmp:\n root=Path(tmp); uid=os.getuid(); gid=os.getgid()\n`;
  expect(
    execFileSync("/usr/bin/python3", ["-I", "-B", "-c", setup + body, file], {
      encoding: "utf8",
    }),
  ).toBe("");
}
test("release newest and all refs survive, partial process visibility and a late open retain the release", () =>
  fixture(` names=['release-'+'a'*40+'-10000000-0000-4000-8000-'+str(n).zfill(12) for n in range(6)]
 for i,n in enumerate(names):
  d=root/n; d.mkdir(mode=0o700); (d/'data').write_text('test'); os.utime(d,(100+i,100+i))
 req=dict(root=tmp,uid=uid,latest=1,keep=names[:3]); busy=os.stat(root/names[3]/'data'); occupied={(busy.st_dev,busy.st_ino)}
 with patch.dict(g,proc_refs=lambda:occupied):
  report=main('releases',req); assert [i['name'] for i in report['candidates']]==[names[4]]; assert report['skipped']==[names[3]]
 item=report['candidates'][0]; req['item']=item
 with patch.dict(g,proc_refs=lambda:(_ for _ in ()).throw(PermissionError())): assert main('releases',req)['skipped']==[item['name']]
 late=os.stat(root/item['name']/'data'); obs=iter([set(),{(late.st_dev,late.st_ino)}]);
 with patch.dict(g,proc_refs=lambda:next(obs)): assert main('releases',req)['skipped']==[item['name']]
 assert (root/item['name']/'data').is_file()
 with patch.dict(g,proc_refs=lambda:set()): assert main('releases',req)['candidates']==[item]
 assert set(os.listdir(tmp))==set(names)-{names[4]}
`));
test("Q-970: isolated contents only, host rmdir rejects a nonempty, replaced, mounted or linked shell", () =>
  fixture(` area=root/'runs'; parent=area/'cardigan'; leaf=parent/'A-1'; leaf.mkdir(parents=True)
 for p in (root,area,parent): p.chmod(0o2750)
 leaf.chmod(0o2770); outside=root/'worktrees';outside.mkdir(); sentinel=outside/'work';sentinel.write_text('unpublished')
 (leaf/'link').symlink_to(outside); cache=leaf/'cache';cache.mkdir();(cache/'file').write_text('data')
 req=dict(root=tmp,uid=uid,gid=gid,names=['A-1'],deadline_ms=__import__('time').time()*1000+4000); agent=uid+10001
 def call_agent(op):
  with patch('os.getuid',return_value=agent): return main(op,req)
 item=call_agent('inventory')['candidates'][0];req['item']=item
 assert main('shell',req)['skipped']==['A-1'] and sentinel.is_file() and cache.is_dir()
 try: main('clear',req); raise AssertionError('host must never recurse')
 except ValueError: pass
 cache.joinpath('.git').mkdir(); assert call_agent('clear')['skipped']==['A-1'] and (cache/'file').is_file();cache.joinpath('.git').rmdir()
 # On the same inode a changed tree needs fresh preview.
 assert call_agent('clear')['skipped']==['A-1'];req['item']=call_agent('inventory')['candidates'][0]
 assert call_agent('clear')['candidates'] and leaf.is_dir() and not list(leaf.iterdir()) and sentinel.read_text()=='unpublished'
 leaf.rename(parent/'saved');leaf.mkdir();leaf.chmod(0o2770);assert main('shell',req)['skipped']==['A-1'];leaf.rmdir();(parent/'saved').rename(leaf)
 with patch.dict(g,mount=lambda fd:'bind' if os.fstat(fd).st_ino==leaf.stat().st_ino else 'parent'): assert main('shell',req)['skipped']==['A-1']
 leaf.rename(parent/'saved');leaf.symlink_to(outside);assert main('shell',req)['skipped']==['A-1'];leaf.unlink();(parent/'saved').rename(leaf)
 assert main('shell',req)['candidates'] and not leaf.exists() and sentinel.is_file()
`));
