import type { AndroidDeviceObservation } from "@cardigan/store";

/**
 * C-813: USB Android devices as schedulable resources.
 *
 * Machine check lists the devices the project account's adb can see; every
 * authorized device is one exclusive instance of `android.device`. A work
 * item may narrow the choice with `android.device.serial.<serial>` or
 * `android.device.model.<model>` (lower case, other characters as `-`).
 * Devices are handed out together with the Run's adb slot (C-679): the slot's
 * private adb server is the only one that holds the device, and closing it at
 * the end of the Run is what frees the device for the next Run.
 */
export const ANDROID_DEVICE_RESOURCE = "android.device";
const SERIAL_PREFIX = `${ANDROID_DEVICE_RESOURCE}.serial.`;
const MODEL_PREFIX = `${ANDROID_DEVICE_RESOURCE}.model.`;
export const MAX_ANDROID_DEVICES = 16;

/** Any key that asks for a real device, plain or narrowed. */
export function isAndroidDeviceKey(key: string) {
  return (
    key === ANDROID_DEVICE_RESOURCE ||
    key.startsWith(`${ANDROID_DEVICE_RESOURCE}.`)
  );
}

const part = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9._-]/gu, "-");

/** Capability keys an authorized device provides on its machine. */
export function androidDeviceCapabilityKeys(
  device: Pick<AndroidDeviceObservation, "serial" | "model">,
): string[] {
  return [
    ANDROID_DEVICE_RESOURCE,
    `${SERIAL_PREFIX}${part(device.serial)}`,
    ...(device.model ? [`${MODEL_PREFIX}${part(device.model)}`] : []),
  ];
}

/** Every narrowing key must name this device. */
export function androidDeviceMatches(
  device: Pick<AndroidDeviceObservation, "serial" | "model">,
  keys: readonly string[],
) {
  const provided = new Set(androidDeviceCapabilityKeys(device));
  return keys
    .filter(
      (key) =>
        isAndroidDeviceKey(key) &&
        (key.startsWith(SERIAL_PREFIX) || key.startsWith(MODEL_PREFIX)),
    )
    .every((key) => provided.has(key));
}

/** A narrowed device requirement also takes one `android.device` slot. */
export function withAndroidDeviceResource(keys: readonly string[]) {
  return keys.some(isAndroidDeviceKey) &&
    !keys.includes(ANDROID_DEVICE_RESOURCE)
    ? [...keys, ANDROID_DEVICE_RESOURCE]
    : [...keys];
}

/** Devices that can be handed to a Run (held ones only by their holder). */
export function usableAndroidDevice(device: AndroidDeviceObservation) {
  return device.state === "authorized" || device.state === "in_use";
}

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
 for r in [l.split() for l in listing.splitlines() if l.strip()][:${MAX_ANDROID_DEVICES}]:
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

const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,63}$/u;
const VERSION = /^\d{1,3}(?:\.\d{1,3}){0,3}$/u;
const STATES: Readonly<Record<string, AndroidDeviceObservation["state"]>> = {
  device: "authorized",
  unauthorized: "unauthorized",
  offline: "offline",
  // Linux: "no permissions (missing udev rules? ...)".
  no: "no_permission",
};

/**
 * Keep only fields that pass strict patterns: never persist arbitrary worker
 * output. Network (wireless) and emulator serials are not real USB devices.
 */
export function parseAndroidDevices(
  output: string,
): AndroidDeviceObservation[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  const list = (value as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list)) return undefined;
  const result = new Map<string, AndroidDeviceObservation>();
  for (const raw of list.slice(0, MAX_ANDROID_DEVICES)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const { serial, state, model, android } = entry;
    if (
      typeof serial !== "string" ||
      !SERIAL.test(serial) ||
      serial.startsWith("emulator-") ||
      typeof state !== "string" ||
      result.has(serial)
    )
      continue;
    const trimmedModel = typeof model === "string" ? model.trim() : "";
    const trimmedVersion = typeof android === "string" ? android.trim() : "";
    result.set(serial, {
      serial,
      state: STATES[state] ?? "other",
      ...(MODEL.test(trimmedModel) ? { model: trimmedModel } : {}),
      ...(VERSION.test(trimmedVersion)
        ? { android_version: trimmedVersion }
        : {}),
    });
  }
  return [...result.values()].sort((a, b) =>
    a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0,
  );
}

/**
 * A device held by a Run's own adb server is invisible (or not usable) to the
 * probe's server. Keep it as `in_use` with what was last known about it, so
 * the machine keeps the capability and later work queues for the device
 * instead of finding no machine.
 */
export function mergeHeldAndroidDevices(
  observed: readonly AndroidDeviceObservation[],
  previous: readonly AndroidDeviceObservation[] | undefined,
  held: ReadonlySet<string>,
): AndroidDeviceObservation[] {
  const result = new Map(observed.map((d) => [d.serial, d]));
  for (const serial of held) {
    const seen = result.get(serial);
    const before = previous?.find((d) => d.serial === serial);
    const known = seen?.state === "authorized" ? seen : before;
    if (!seen && !before) continue;
    result.set(serial, {
      serial,
      state: "in_use",
      ...(known?.model ? { model: known.model } : {}),
      ...(known?.android_version
        ? { android_version: known.android_version }
        : {}),
    });
  }
  return [...result.values()].sort((a, b) =>
    a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0,
  );
}
