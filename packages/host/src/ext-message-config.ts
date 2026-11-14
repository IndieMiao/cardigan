import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { EXT_MESSAGE_DEFAULTS, type ExtMessagePolicy } from "@cardigan/domain";
import { parse } from "yaml";
import { parseFeishuCredential } from "./ext-message-feishu.js";

export interface ExtMessageConfig {
  readonly enabled: boolean;
  readonly workbench_url: string;
  readonly policy: ExtMessagePolicy;
  readonly channels: Readonly<
    Record<string, { readonly enabled: boolean; readonly credential?: string }>
  >;
  readonly quiet_hours?: {
    readonly timezone: string;
    readonly start: string;
    readonly end: string;
  };
}
export type ExtMessageConfiguration =
  | { readonly status: "missing" | "invalid" }
  | { readonly status: "loaded"; readonly config: ExtMessageConfig };
export const defaultExtMessagePath = () =>
  join(
    process.env.CARDIGAN_CONFIG_DIR ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "cardigan",
      ),
    "ext-message.yaml",
  );
const invalid = (): never => {
  throw new Error("外部通知配置无效");
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
};
const bool = (value: unknown, fallback = false): boolean =>
  value === undefined
    ? fallback
    : typeof value === "boolean"
      ? value
      : invalid();
const integer = (value: unknown, fallback: number): number => {
  const n = value ?? fallback;
  if (
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    n > 2_147_483_647
  )
    return invalid();
  return n;
};
/** Check the opened file, not a path stat before an attacker could swap it. */
function privateText(path: string): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o7777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      return invalid();
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
export function loadExtMessageConfig(
  path = defaultExtMessagePath(),
): ExtMessageConfiguration {
  let text: string;
  try {
    text = privateText(path);
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "invalid",
    };
  }
  try {
    const raw = record(parse(text));
    const enabled = bool(raw.enabled);
    const base = raw.workbench_url ?? "";
    if (typeof base !== "string") return invalid();
    if (enabled || base) {
      const url = new URL(base);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return invalid();
    }
    const policyRaw = raw.policy === undefined ? {} : record(raw.policy);
    const max_attempts = integer(
      policyRaw.max_attempts,
      EXT_MESSAGE_DEFAULTS.max_attempts,
    );
    const delays =
      policyRaw.retry_delays_ms ?? EXT_MESSAGE_DEFAULTS.retry_delays_ms;
    if (!Array.isArray(delays) || delays.length !== max_attempts - 1)
      return invalid();
    const policy: ExtMessagePolicy = {
      timeout_ms: integer(
        policyRaw.timeout_ms,
        EXT_MESSAGE_DEFAULTS.timeout_ms,
      ),
      max_attempts,
      retry_delays_ms: delays.map((n) => integer(n, 0)),
      title_limit: integer(
        policyRaw.title_limit,
        EXT_MESSAGE_DEFAULTS.title_limit,
      ),
      digest_limit: integer(
        policyRaw.digest_limit,
        EXT_MESSAGE_DEFAULTS.digest_limit,
      ),
    };
    const channels: Record<string, { enabled: boolean; credential?: string }> =
      {};
    for (const [name, value] of Object.entries(
      raw.channels === undefined ? {} : record(raw.channels),
    )) {
      if (
        !/^[a-z][a-z0-9_-]*$/u.test(name) ||
        ["constructor", "prototype", "__proto__"].includes(name)
      )
        return invalid();
      const channel = record(value);
      const active = bool(channel.enabled);
      if (
        channel.credential !== undefined &&
        channel.credential_file !== undefined
      )
        return invalid();
      let credential: string | undefined;
      // Disabled channels never read secrets. Error results never contain input or paths.
      if (enabled && active) {
        if (channel.credential !== undefined) {
          if (
            typeof channel.credential !== "string" ||
            !channel.credential.trim()
          )
            return invalid();
          credential = channel.credential;
        } else if (channel.credential_file !== undefined) {
          if (
            typeof channel.credential_file !== "string" ||
            !channel.credential_file
          )
            return invalid();
          const file = channel.credential_file;
          credential = privateText(
            isAbsolute(file) ? file : resolve(dirname(path), file),
          ).trim();
          if (!credential) return invalid();
        }
      }
      if (enabled && active && name === "lark")
        parseFeishuCredential(credential);
      channels[name] = {
        enabled: active,
        ...(credential === undefined ? {} : { credential }),
      };
    }
    let quiet_hours: ExtMessageConfig["quiet_hours"];
    if (raw.quiet_hours !== undefined) {
      const quiet = record(raw.quiet_hours);
      if (bool(quiet.enabled)) {
        if (
          typeof quiet.timezone !== "string" ||
          typeof quiet.start !== "string" ||
          typeof quiet.end !== "string" ||
          !/^([01]\d|2[0-3]):[0-5]\d$/u.test(quiet.start) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/u.test(quiet.end) ||
          quiet.start === quiet.end
        )
          return invalid();
        new Intl.DateTimeFormat("en", { timeZone: quiet.timezone }).format();
        quiet_hours = {
          timezone: quiet.timezone,
          start: quiet.start,
          end: quiet.end,
        };
      }
    }
    return {
      status: "loaded",
      config: {
        enabled,
        workbench_url: base,
        channels,
        policy,
        ...(quiet_hours ? { quiet_hours } : {}),
      },
    };
  } catch {
    return { status: "invalid" };
  }
}
export function extMessageQuiet(
  config: ExtMessageConfig,
  now: string,
): boolean {
  const q = config.quiet_hours;
  if (!q) return false;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: q.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(now));
  return q.start < q.end
    ? time >= q.start && time < q.end
    : time >= q.start || time < q.end;
}
