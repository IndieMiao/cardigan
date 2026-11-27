import {
  type DeviceObservation,
  type DeviceSessionContext,
  MAX_DEVICES_PER_PROVIDER,
} from "@cardigan/domain";
import type { HostDeviceProvider } from "./device-provider-host.js";

/**
 * C-813: the first device provider: USB Android devices seen by adb.
 *
 * USB devices can be held by only one adb server at a time. A device is
 * therefore only handed to the Run's **own** adb server (its C-679 adb slot):
 * the provider requires the machine's `adb_slots` to include `android.device`,
 * other slot Runs on such a machine get `ADB_USB=0` so their servers never
 * claim USB, and a device lease is released only after the holder's slot
 * (its adb server) has been closed.
 */
export const ANDROID_DEVICE_TYPE = "android.device";

/**
 * Runs as the project account on the worker, inside the capability probe
 * wrapper (time and output bounded there; the wrapper kills the process group
 * on exit). It starts a throw-away `adb server nodaemon` on a free loopback
 * port with emulator and mDNS discovery off, talks to it with the adb host
 * protocol directly (an adb client would start a lasting daemon if the server
 * died), reads `ro.product.model` / `ro.build.version.release` from authorized
 * devices, then stops the server. The account's long-lived adb servers, the
 * worker environment's pinned port and devices another server holds are left
 * alone. Prints `{"devices": [...]}`; exits non-zero when no server came up.
 */
export const ANDROID_DEVICE_PROBE_SCRIPT = `import json,os,socket,subprocess,sys,time
deadline=time.monotonic()+8.0
env=dict(os.environ,ADB_MDNS='0',ADB_EMU='0',ADB_MDNS_AUTO_CONNECT='0')
for k in ('ANDROID_SERIAL','ADB_SERVER_SOCKET','ANDROID_ADB_SERVER_ADDRESS','ANDROID_ADB_SERVER_PORT','ADB_USB'): env.pop(k,None)
s=socket.socket(); s.bind(('127.0.0.1',0)); port=s.getsockname()[1]; s.close()
def left(): return deadline-time.monotonic()
def recvn(c,n):
 b=b''
 while len(b)<n:
  d=c.recv(n-len(b))
  if not d: raise OSError()
  b+=d
 return b
def send(c,p): c.sendall(b'%04x'%len(p)+p)
def connect():
 c=socket.create_connection(('127.0.0.1',port),max(0.1,min(1.0,left()))); c.settimeout(max(0.1,min(2.0,left()))); return c
def devices():
 try:
  c=connect()
 except OSError:
  return None
 try:
  send(c,b'host:devices-l')
  if recvn(c,4)!=b'OKAY': return None
  return recvn(c,int(recvn(c,4),16)).decode('utf-8','replace')
 except (OSError,ValueError):
  return None
 finally:
  c.close()
def props(serial):
 try:
  c=connect()
 except OSError:
  return None
 try:
  send(c,b'host:transport:'+serial.encode())
  if recvn(c,4)!=b'OKAY': return None
  send(c,b'shell:getprop ro.product.model;getprop ro.build.version.release')
  if recvn(c,4)!=b'OKAY': return None
  out=b''
  while len(out)<4096:
   d=c.recv(4096)
   if not d: break
   out+=d
  lines=[l.strip() for l in out.decode('utf-8','replace').splitlines()]
  return lines if len(lines)>=2 else None
 except OSError:
  return None
 finally:
  c.close()
server=subprocess.Popen(['adb','-P',str(port),'server','nodaemon'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env)
try:
 listing=None
 while listing is None and left()>3 and server.poll() is None:
  time.sleep(0.2); listing=devices()
 if listing is None: sys.exit(1)
 settle=time.monotonic()+1.5
 while left()>3:
  rows=[l.split() for l in listing.splitlines() if l.strip()]
  if time.monotonic()>=settle and not any(len(r)>1 and r[1] in ('connecting','authorizing') for r in rows): break
  time.sleep(0.5); listing=devices() or listing
 found=[]
 for r in [l.split() for l in listing.splitlines() if l.strip()][:${MAX_DEVICES_PER_PROVIDER}]:
  if len(r)<2 or r[0].startswith('emulator-'): continue
  d=dict(serial=r[0],state=r[1])
  info=dict(p.split(':',1) for p in r[2:] if ':' in p)
  if info.get('model'): d['model']=info['model']
  if r[1]=='device':
   p=props(r[0])
   if p:
    d['model']=p[0] or d.get('model','')
    d['android']=p[1]
  found.append(d)
 print(json.dumps(dict(devices=found)),flush=True)
finally:
 try:
  c=connect(); send(c,b'host:kill'); c.close()
 except OSError:
  pass
 try:
  server.wait(timeout=max(0.1,min(1.0,left()+1)))
 except subprocess.TimeoutExpired:
  server.kill(); server.wait()
`;

export const ANDROID_DEVICE_PROBE_COMMAND = [
  "python3",
  "-I",
  "-B",
  "-c",
  ANDROID_DEVICE_PROBE_SCRIPT,
] as const;

const STATES: Readonly<Record<string, DeviceObservation["state"]>> = {
  device: "available",
  unauthorized: "unauthorized",
  offline: "offline",
};

/**
 * adb rows to the generic shape (validated again by the domain). Emulator and
 * network (wireless) serials are not USB devices; "no permissions" (Linux udev)
 * and other adb states are `unavailable`.
 */
export function parseAndroidDevices(output: string): unknown[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  const list = (value as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const { serial, state, model, android } = entry;
    if (
      typeof serial !== "string" ||
      serial.startsWith("emulator-") ||
      serial.includes(":") ||
      typeof state !== "string"
    )
      return [];
    return [
      {
        id: serial,
        state: STATES[state] ?? "unavailable",
        ...(typeof model === "string" ? { model } : {}),
        ...(typeof android === "string" ? { version: android } : {}),
      },
    ];
  });
}

const ONE_DEVICE = "adb --one-device $CARDIGAN_DEVICE_SERIAL start-server";

export const androidDeviceProvider: HostDeviceProvider = {
  type: ANDROID_DEVICE_TYPE,
  label: "安卓真机",
  os: ["linux", "darwin"],
  requires_capability: "android.sdk",
  needs_adb_slot: true,
  setup_steps: [
    { title: "平板打开开发者选项里的 USB 调试，用 USB 线接到机器" },
    {
      title:
        "用项目的专用账号临时起一个 adb 服务，在平板上勾选“始终允许”并确认授权，然后关掉它",
      command:
        "adb -P 15999 start-server && adb -P 15999 devices -l && adb -P 15999 kill-server",
    },
    {
      title:
        "关掉机器上常驻的 adb 服务（例如以前写死的固定端口），真机只交给 Run 自己的 adb 服务",
    },
  ],
  async list({ execution, os, probe, signal }) {
    const result = await probe(
      execution,
      os,
      ANDROID_DEVICE_PROBE_COMMAND,
      signal,
    );
    return result.ok ? parseAndroidDevices(result.output) : undefined;
  },
  sessionEnv(device: DeviceObservation, context: DeviceSessionContext) {
    // With an emulator as well, ANDROID_SERIAL stays on the emulator so
    // existing emulator scripts keep working; both serials are given.
    return context.emulator_serial
      ? {
          CARDIGAN_DEVICE_SERIAL: device.id,
          CARDIGAN_EMULATOR_SERIAL: context.emulator_serial,
        }
      : { ANDROID_SERIAL: device.id, CARDIGAN_DEVICE_SERIAL: device.id };
  },
  sessionRule(_device, context) {
    return context.emulator_serial
      ? `本次 Run 同时有模拟器和 USB 真机：ANDROID_SERIAL 和 $CARDIGAN_EMULATOR_SERIAL 指向模拟器，真机是 $CARDIGAN_DEVICE_SERIAL，操作真机必须写 adb -s $CARDIGAN_DEVICE_SERIAL。第一条 adb 命令前先执行 ${ONE_DEVICE}，只占用这一台真机；不要操作其它真机。Run 结束时系统关闭 adb 服务并释放真机。`
      : `本次 Run 独占 USB 真机 $CARDIGAN_DEVICE_SERIAL（ANDROID_SERIAL 已指向它）。第一条 adb 命令前先执行 ${ONE_DEVICE}，只占用这一台；不要操作其它真机。Run 结束时系统关闭 adb 服务并释放真机。`;
  },
};
