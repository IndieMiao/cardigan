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
test("Q-979: release observations are read-only; even an exact receipt cannot invoke removal", () =>
  fixture(` n='release-'+'a'*40+'-10000000-0000-4000-8000-000000000001'; d=root/n; d.mkdir(mode=0o700); (d/'data').write_text('retained')
 req=dict(root=tmp,uid=uid,names=[n]); item=main('release_inventory',req)['candidates'][0]; assert item['size_bytes']>0
 for op in ('releases','release_inventory','snapshot','clear','shell'):
  try: main(op,{**req,'item':item}); raise AssertionError('release mutator')
  except (ValueError,KeyError): pass
 assert (d/'data').read_text()=='retained'
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

test("matches the entries observed before clear; never consumes new content or a substituted inode", () =>
  fixture(` area=root/'runs';parent=area/'cardigan';leaf=parent/'A-1'; leaf.mkdir(parents=True)
 for p in (root,area,parent): p.chmod(0o2750)
 leaf.chmod(0o2770); file=leaf/'cache';file.write_text('original'); req=dict(root=tmp,uid=uid,gid=gid,names=['A-1'],deadline_ms=__import__('time').time()*1000+4000)
 with patch('os.getuid',return_value=uid+10001):
  for variant in ('addition','replacement','at_claim'):
   req['item']=main('inventory',req)['candidates'][0]; old=g['clear_plan']; rename=g['rename_new']; added=leaf/'new'
   def replace(): file.rename(root/'saved'); file.write_text('replacement')
   def change(d,entries,guard):
    if variant=='addition': added.write_text('new')
    if variant=='replacement': replace()
    old(d,entries,guard)
   def change_at_claim(d,src,dst):
    if variant=='at_claim' and src=='cache': replace()
    rename(d,src,dst)
   with patch.dict(g,clear_plan=change,rename_new=change_at_claim): assert main('clear',req)['skipped']==['A-1']
   if variant=='addition': assert file.read_text()=='original' and added.read_text()=='new';added.unlink()
   else: assert file.read_text()=='replacement';file.unlink();(root/'saved').rename(file)
`));

test("a hard link added after preview retains the whole run, including earlier entries", () =>
  fixture(` area=root/'runs'; parent=area/'cardigan'; leaf=parent/'A-1'; leaf.mkdir(parents=True)
 for p in (root,area,parent): p.chmod(0o2750)
 leaf.chmod(0o2770); a=leaf/'a'; a.write_text('a'); b=leaf/'b'; b.write_text('b')
 req=dict(root=tmp,uid=uid,gid=gid,names=['A-1'],deadline_ms=__import__('time').time()*1000+4000)
 with patch('os.getuid',return_value=uid+10001):
  req['item']=main('inventory',req)['candidates'][0]
  os.link(b,leaf/'b2')
  for op in ('inventory','clear'):
   assert main(op,req)=={'candidates':[],'skipped':['A-1'],'skip_reasons':{'A-1':'hard_linked_run'}}
  assert a.read_text()=='a' and b.read_text()==(leaf/'b2').read_text()=='b' and b.stat().st_nlink==2
`));
