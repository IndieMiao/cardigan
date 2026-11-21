import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Exercise the real filesystem in temporary directories, without provisioning accounts.
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
const runFixture = (body: string) =>
  fixture(` area=root/'runs'; parent=area/'cardigan'; leaf=parent/'A-1'; leaf.mkdir(parents=True)
 for p in (root,area,parent): p.chmod(0o2750)
 leaf.chmod(0o2770); req=dict(root=tmp,uid=uid,gid=gid,names=['A-1'])
 def inventory():
  with patch('os.getuid',return_value=uid+10001): return main('inventory',req)
 def shell(item): return main('shell',{**req,'item':item})
${body}`);

test("Q-1057: nonempty runs are not traversed, even with a receipt; neither account can clear them", () =>
  runFixture(` item=inventory()['candidates'][0]
 a=leaf/'a'; a.write_text('keep'); os.link(a,leaf/'b'); cache=leaf/'cache'; cache.mkdir(); (cache/'nested').write_text('keep')
 outside=root/'worktrees'; outside.mkdir(); (leaf/'link').symlink_to(outside)
 expected={'candidates':[],'skipped':['A-1'],'skip_reasons':{'A-1':'nonempty_run'}}
 real_open=os.open
 def no_contents(name,flags,**kw):
  assert name not in ('a','b','cache','nested','link'); return real_open(name,flags,**kw)
 with patch('os.open',side_effect=no_contents):
  assert inventory()==shell(item)==expected
  for who in (uid,uid+10001):
   with patch('os.getuid',return_value=who):
    try: main('clear',{**req,'item':item}); raise AssertionError('content mutator')
    except ValueError: pass
 assert a.stat().st_nlink==2 and (leaf/'b').read_text()==a.read_text()=='keep'
 assert (leaf/'link').is_symlink() and (cache/'nested').read_text()=='keep'
`));

test("only the host removes the original empty shell with matching identity, mount and stamp", () =>
  runFixture(` item=inventory()['candidates'][0]
 with patch('os.getuid',return_value=uid+10001):
  try: shell(item); raise AssertionError('agent cannot rmdir')
  except ValueError: pass
 assert shell({**item,'stamp':'0'*64})['skipped']==['A-1']
 with patch.dict(g,mount=lambda fd:'bind' if os.fstat(fd).st_ino==leaf.stat().st_ino else 'parent'):
  assert inventory()['skipped']==shell(item)['skipped']==['A-1']
 leaf.rename(parent/'saved'); leaf.symlink_to(parent/'saved'); assert shell(item)['skipped']==['A-1']; leaf.unlink()
 leaf.mkdir(); leaf.chmod(0o2770); assert shell(item)['skipped']==['A-1'] and leaf.is_dir()
 fresh=inventory()['candidates'][0]; assert shell(fresh)['candidates']==[fresh] and not leaf.exists() and (parent/'saved').is_dir()
`));

test("a file created at the final rmdir is retained, with no recursive fallback", () =>
  runFixture(` item=inventory()['candidates'][0]; real_rmdir=os.rmdir
 def add_then_rmdir(name,*,dir_fd):
  assert name=='A-1'; (leaf/'new').write_text('keep'); return real_rmdir(name,dir_fd=dir_fd)
 with patch('os.rmdir',side_effect=add_then_rmdir): assert shell(item)['skipped']==['A-1']
 assert (leaf/'new').read_text()=='keep'
`));
