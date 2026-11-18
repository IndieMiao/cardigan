import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CardiganClient, ExecutionDiagnosticsData } from "../api.js";
import {
  CompactNotice,
  CompactNoticeBody,
  CompactNoticeEnd,
  CompactNoticeLine,
  CompactNoticeToggleContent,
  compactNoticePanelClassName,
  compactNoticeToggleClassName,
} from "./layout/CompactNoticeLayout.js";
import { Button } from "./ui/button.js";
import * as Popover from "./ui/popover.js";

const causes: Readonly<Record<string, string>> = {
  waiting_confirmation: "等待交互确认",
  waiting_interaction: "等待交互，类型未确认",
  runtime_exited: "运行终端已退出",
  upstream_unreachable: "线路连接失败",
  upstream_suspected: "疑似线路异常",
  agent_stalled: "会话失活",
  server_problem: "主机派发异常",
  unknown: "运行原因未知",
};

function validDiagnostics(value: ExecutionDiagnosticsData): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.configuration) &&
    Array.isArray(value.sessions) &&
    value.configuration.every(
      (w) =>
        w &&
        typeof w.profile === "string" &&
        typeof w.code === "string" &&
        typeof w.message === "string",
    ) &&
    value.sessions.every(
      (s) =>
        s &&
        typeof s.assignment_id === "string" &&
        typeof s.cause === "string" &&
        Array.isArray(s.evidence) &&
        s.evidence.every((e: unknown) => typeof e === "string"),
    )
  );
}

export type DiagnosticsState =
  | "checking"
  | "ok"
  | "unavailable"
  | "stale"
  | "warn";

/** One diagnostics read shared by the header status and the attention row. */
export function useExecutionDiagnostics(
  client: CardiganClient,
  projectId: string,
) {
  const [data, setData] = useState<ExecutionDiagnosticsData>();
  const [request, setRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  const supported = !!client.executionDiagnostics;
  const source = useRef<unknown>(undefined);
  const projectKey = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: request is the explicit user refresh generation.
  useEffect(() => {
    if (!client.executionDiagnostics) return;
    let current = true;
    // A manual refresh keeps the previous warnings in place until the new
    // result arrives so the attention row does not collapse and reappear.
    if (source.current !== client || projectKey.current !== projectId) {
      setData(undefined);
      setStale(false);
    }
    source.current = client;
    projectKey.current = projectId;
    setBusy(true);
    setFailed(false);
    void client
      .executionDiagnostics(projectId)
      .then(
        (value) => {
          if (!current) return;
          setStale(false);
          if (validDiagnostics(value)) setData(value);
          else {
            setData(undefined);
            setFailed(true);
          }
        },
        () => {
          if (!current) return;
          setStale(false);
          setData(undefined);
          setFailed(true);
        },
      )
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [client, projectId, request]);
  useEffect(() => {
    if (!data?.expires_at) return;
    const remaining = Date.parse(data.expires_at) - Date.now();
    const timer = setTimeout(() => setStale(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [data]);
  // Warnings swap the header status for the attention row (and back). If the
  // keyboard was in the old entry when it unmounts, the new entry takes focus;
  // a pointer press or focus elsewhere means the user moved on.
  const focusInside = useRef(false);
  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest("[data-diagnostics-entry]") !== null;
    const onFocusIn = (event: FocusEvent) => {
      focusInside.current = inside(event.target);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) focusInside.current = false;
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  const claimFocus = useCallback((target: HTMLElement | null) => {
    const active = document.activeElement;
    if (
      target &&
      focusInside.current &&
      (!active || active === document.body || !active.isConnected)
    )
      target.focus();
  }, []);
  const sessions = stale
    ? []
    : (data?.sessions.filter((s) => causes[s.cause]) ?? []);
  const count = (data?.configuration.length ?? 0) + sessions.length;
  const unavailable = failed || data?.available === false;
  const state: DiagnosticsState =
    count > 0
      ? "warn"
      : busy || (!data && !unavailable)
        ? "checking"
        : unavailable
          ? "unavailable"
          : stale
            ? "stale"
            : "ok";
  return {
    supported,
    data,
    busy,
    stale,
    unavailable,
    sessions,
    count,
    state,
    claimFocus,
    refresh: () => setRequest((n) => n + 1),
  };
}
export type ExecutionDiagnosticsResource = ReturnType<
  typeof useExecutionDiagnostics
>;

const stateLabel: Readonly<Record<DiagnosticsState, string>> = {
  checking: "检查中",
  ok: "无告警",
  unavailable: "不可用",
  stale: "已过期",
  warn: "有告警",
};

function RefreshButton({
  diagnostics,
}: {
  diagnostics: ExecutionDiagnosticsResource;
}) {
  // aria-disabled keeps keyboard focus in place while a check is pending.
  return (
    <Button
      type="button"
      aria-disabled={diagnostics.busy || undefined}
      onClick={() => {
        if (!diagnostics.busy) diagnostics.refresh();
      }}
    >
      {diagnostics.busy ? "检查中" : "刷新诊断"}
    </Button>
  );
}

function Messages({
  diagnostics,
}: {
  diagnostics: ExecutionDiagnosticsResource;
}) {
  const { unavailable, stale, state } = diagnostics;
  return (
    <>
      {state === "checking" && <p role="status">检查中</p>}
      {unavailable && state !== "checking" && <p role="status">诊断不可用</p>}
      {stale && <p role="status">运行诊断已过期，请刷新</p>}
      {state === "ok" && <p>没有告警</p>}
    </>
  );
}

/** Header summary item for every state without warnings; null otherwise. */
export function ExecutionDiagnosticsStatus({
  diagnostics,
}: {
  diagnostics: ExecutionDiagnosticsResource;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = diagnostics.supported && diagnostics.state !== "warn";
  const { claimFocus } = diagnostics;
  useEffect(() => {
    if (visible) claimFocus(trigger.current);
  }, [visible, claimFocus]);
  if (!visible) return null;
  const label = stateLabel[diagnostics.state];
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          className="ui-page-status-trigger"
          aria-label={`启动与运行诊断：${label}`}
          data-diagnostics-entry=""
          data-diagnostics-trigger=""
          data-diagnostics-state={diagnostics.state}
        >
          诊断 · {label}
        </Button>
      </Popover.Trigger>
      <Popover.PopoverContent
        aria-label="启动与运行诊断"
        side="bottom"
        align="end"
        sideOffset={4}
        collisionPadding={12}
        className={compactNoticePanelClassName}
        data-diagnostics-entry=""
        data-diagnostics-panel=""
      >
        <strong>启动与运行诊断</strong>
        <Messages diagnostics={diagnostics} />
        <RefreshButton diagnostics={diagnostics} />
      </Popover.PopoverContent>
    </Popover.Root>
  );
}

/** Compact attention row shown only while warnings exist; expands in place. */
export function ExecutionDiagnosticsAlert({
  diagnostics,
  onOpen,
}: {
  readonly diagnostics: ExecutionDiagnosticsResource;
  readonly onOpen: (id: string, trigger: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const { data, sessions, count, claimFocus } = diagnostics;
  const visible = diagnostics.supported && count > 0;
  useEffect(() => {
    if (visible) claimFocus(toggle.current);
  }, [visible, claimFocus]);
  if (!visible) return null;
  return (
    <CompactNotice
      aria-label="启动与运行诊断"
      data-diagnostics-entry=""
      data-diagnostics-alert=""
    >
      <CompactNoticeLine>
        <Button
          ref={toggle}
          type="button"
          variant="ghost"
          className={compactNoticeToggleClassName}
          aria-expanded={open}
          aria-controls={id}
          data-diagnostics-trigger=""
          data-diagnostics-state="warn"
          onClick={() => setOpen((value) => !value)}
        >
          <CompactNoticeToggleContent>
            启动与运行诊断（{count}）
          </CompactNoticeToggleContent>
        </Button>
        <CompactNoticeEnd>
          <RefreshButton diagnostics={diagnostics} />
        </CompactNoticeEnd>
      </CompactNoticeLine>
      <CompactNoticeBody id={id} hidden={!open}>
        <Messages diagnostics={diagnostics} />
        <ul>
          {data?.configuration.map((w) => (
            <li key={`${w.profile}:${w.code}`}>
              <strong>配置告警 · {w.profile}</strong>
              <p>{w.message}</p>
            </li>
          ))}
          {sessions.map((s) => (
            <li key={s.assignment_id}>
              <strong>{causes[s.cause]}</strong>
              {s.cause === "waiting_confirmation" && (
                <p>请接入终端核对确认请求。</p>
              )}
              {s.cause === "waiting_interaction" && (
                <p>请接入终端核对等待原因。</p>
              )}
              {s.cause === "runtime_exited" && (
                <p>
                  请核对 Run
                  状态；停止已完成的会话可手工恢复，退出未确认时交主机运维。
                </p>
              )}
              {s.cause === "unknown" && (
                <p>观察不足，请检查运行状态后再决定是否恢复。</p>
              )}
              {s.evidence.includes("connection_probe_failed") &&
                s.cause !== "upstream_unreachable" && (
                  <p>同时检测到线路连接失败。</p>
                )}
              <Button
                type="button"
                onClick={(event) =>
                  onOpen(s.assignment_id, event.currentTarget)
                }
              >
                查看 {s.assignment_id}
              </Button>
            </li>
          ))}
        </ul>
      </CompactNoticeBody>
    </CompactNotice>
  );
}
