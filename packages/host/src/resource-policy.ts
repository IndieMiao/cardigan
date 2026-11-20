import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

export type ProbeCommand = readonly [string, ...string[]];
export type ResourceBinding = {
  port?: number;
  device?: string;
  release?: ProbeCommand;
};
export type ResourcePolicy = {
  reservableBy: ReadonlySet<string>;
  checks: ReadonlyMap<string, ProbeCommand>;
  bindings: ReadonlyMap<string, ResourceBinding>;
};
export type MachinePolicy = ReadonlyMap<string, ResourcePolicy>;
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function invalid(): never {
  throw new Error("Invalid resource policy");
}
function fields(raw: unknown, allowed?: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    (allowed && Object.keys(raw).some((k) => !allowed.includes(k)))
  )
    return invalid();
  return raw as Record<string, unknown>;
}
function command(raw: unknown): ProbeCommand {
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    raw.some((v) => typeof v !== "string" || /[\p{Cc}\p{Cf}]/u.test(v)) ||
    !isAbsolute(raw[0]) ||
    normalize(raw[0]) !== raw[0]
  )
    return invalid();
  return [raw[0], ...raw.slice(1)];
}
export function parseResourcePolicies(
  raw: unknown,
  slots: ReadonlyMap<string, number>,
): MachinePolicy {
  const policies = new Map<string, ResourcePolicy>(),
    ports = new Set<number>(),
    devices = new Set<string>();
  for (const [key, value] of Object.entries(fields(raw))) {
    if (!slots.has(key)) return invalid();
    const p = fields(value, ["checks", "bindings", "reservable_by"]);
    const checks = new Map<string, ProbeCommand>(),
      bindings = new Map<string, ResourceBinding>();
    for (const [name, argv] of Object.entries(
      fields(p.checks === undefined ? {} : p.checks),
    )) {
      if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) return invalid();
      checks.set(name, command(argv));
    }
    for (const [project, v] of Object.entries(
      fields(p.bindings === undefined ? {} : p.bindings),
    )) {
      if (!project.trim() || slots.get(key) !== 1) return invalid();
      const {
        adb_port: port,
        device,
        release,
      } = fields(v, ["adb_port", "device", "release"]);
      if (port === undefined && device === undefined) return invalid();
      const binding: ResourceBinding = {};
      if (port !== undefined) {
        if (
          typeof port !== "number" ||
          !Number.isSafeInteger(port) ||
          port < 1 ||
          port > 65535 ||
          port === 5037 ||
          ports.has(port)
        )
          return invalid();
        ports.add(port);
        binding.port = port;
      }
      if (device !== undefined) {
        if (
          typeof device !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$/.test(device) ||
          devices.has(device)
        )
          return invalid();
        devices.add(device);
        binding.device = device;
      }
      if (release !== undefined) binding.release = command(release);
      bindings.set(project, binding);
    }
    const list = p.reservable_by === undefined ? [] : p.reservable_by;
    if (
      !Array.isArray(list) ||
      list.some((v) => typeof v !== "string" || !v.trim()) ||
      new Set(list).size !== list.length ||
      (!list.length && !checks.size && !bindings.size)
    )
      return invalid();
    policies.set(key, {
      checks,
      bindings,
      reservableBy: new Set<string>(list),
    });
  }
  return policies;
}
export function bindingIdentity(b: ResourceBinding) {
  return fingerprint([b.port, b.device]);
}
export function endpoints(b: ResourceBinding) {
  return [
    ...(b.port ? [fingerprint(["port", b.port])] : []),
    ...(b.device ? [fingerprint(["device", b.device])] : []),
  ];
}
