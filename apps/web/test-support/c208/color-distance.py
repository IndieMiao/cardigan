"""C-204 design evidence: sRGB D65 -> CIELAB and CIEDE2000 (kL=kC=kH=1)."""
import math

def lab(hex_value):
    rgb=[int(hex_value[i:i+2],16)/255 for i in (1,3,5)]
    r,g,b=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    xyz=[(.4124564*r+.3575761*g+.1804375*b)/.95047, .2126729*r+.7151522*g+.0721750*b, (.0193339*r+.1191920*g+.9503041*b)/1.08883]
    x,y,z=[v**(1/3) if v>(6/29)**3 else v/(3*(6/29)**2)+4/29 for v in xyz]
    return 116*y-16,500*(x-y),200*(y-z)

def delta(a,b):
    l1,a1,b1=a; l2,a2,b2=b
    c1=math.hypot(a1,b1);c2=math.hypot(a2,b2);cm=(c1+c2)/2
    g=.5*(1-math.sqrt(cm**7/(cm**7+25**7)))
    ap1=(1+g)*a1;ap2=(1+g)*a2
    cp1=math.hypot(ap1,b1);cp2=math.hypot(ap2,b2)
    hp1=math.degrees(math.atan2(b1,ap1))%360;hp2=math.degrees(math.atan2(b2,ap2))%360
    dl=l2-l1;dc=cp2-cp1;dh=hp2-hp1
    if cp1*cp2==0:dh=0
    elif dh>180:dh-=360
    elif dh < -180:dh+=360
    dH=2*math.sqrt(cp1*cp2)*math.sin(math.radians(dh/2))
    lm=(l1+l2)/2;cm=(cp1+cp2)/2
    if cp1*cp2==0:hm=hp1+hp2
    elif abs(hp1-hp2)<=180:hm=(hp1+hp2)/2
    elif hp1+hp2<360:hm=(hp1+hp2+360)/2
    else:hm=(hp1+hp2-360)/2
    t=1-.17*math.cos(math.radians(hm-30))+.24*math.cos(math.radians(2*hm))+.32*math.cos(math.radians(3*hm+6))-.20*math.cos(math.radians(4*hm-63))
    sl=1+.015*(lm-50)**2/math.sqrt(20+(lm-50)**2);sc=1+.045*cm;sh=1+.015*cm*t
    rt=-2*math.sqrt(cm**7/(cm**7+25**7))*math.sin(math.radians(60*math.exp(-((hm-275)/25)**2)))
    return math.sqrt((dl/sl)**2+(dc/sc)**2+(dH/sh)**2+rt*(dc/sc)*(dH/sh))

if __name__=='__main__':
    import json,itertools
    from pathlib import Path
    # Published Sharma supplemental reference pairs (CIEDE2000).
    for a,b,expected in [((50,2.6772,-79.7751),(50,0,-82.7485),2.0425),((50,3.1571,-77.2803),(50,0,-82.7485),2.8615),((50,2.8361,-74.0200),(50,0,-82.7485),3.4412)]:
        assert abs(delta(a,b)-expected)<.0001
    p=json.loads(Path(__file__).with_name('palette.json').read_text())
    labels=p['labels'][:9]
    rows=[]
    for kind,_,fg,bg in p['labels']:
        peers=[r for r in labels if r[0]!=kind]
        nearest=min(peers,key=lambda r:delta(lab(fg),lab(r[2])))
        bgnear=min(peers,key=lambda r:delta(lab(bg),lab(r[3])))
        statuses=[(k,v) for k,v in p['after'].items() if k.startswith('--status-') and k!='--status-cutout' or k=='--danger']
        status=min(statuses,key=lambda r:delta(lab(fg),lab(r[1])))
        assert delta(lab(fg),lab(status[1])) >= 10
        rows.append(f'| {kind} | {nearest[0]} / {delta(lab(fg),lab(nearest[2])):.2f} | {bgnear[0]} / {delta(lab(bg),lab(bgnear[3])):.2f} | {status[0]} / {delta(lab(fg),lab(status[1])):.2f} |')
    pairs=[(a[0],b[0],delta(lab(a[2]),lab(b[2])),delta(lab(a[3]),lab(b[3]))) for a,b in itertools.combinations(labels,2)]
    assert min(r[2] for r in pairs)>=10
    assert min(r[3] for r in pairs)>=5
    output=Path(__file__).resolve().parents[4]/'docs/design/c208/distance.md'
    output.write_text('# C-204 暗色色差\n\nsRGB、D65、CIEDE2000，kL=kC=kH=1。以 C/W/Q/A/R/D/V/H/E 九类为最近邻集合；M/MB/unknown 允许共用 E 的中性族。三组 Sharma 标准参考对误差小于 0.0001。\n\n| 类型 | 最近文字邻色 / ΔE00 | 最近底色邻色 / ΔE00 | 最近状态色 / ΔE00 |\n|---|---|---|---|\n'+'\n'.join(rows)+'\n\n九类全部 36 对：\n\n| 类型对 | 文字 ΔE00 | 底色 ΔE00 |\n|---|---|---|\n'+'\n'.join(f'| {a} / {b} | {fg:.2f} | {bg:.2f} |' for a,b,fg,bg in pairs)+'\n')
    print('36 pairs passed: text >= 10, background >= 5')
