import { useEffect, useRef, useState } from "react";
import type {
  MachineBindingView,
  MachineCapabilityView,
  MachineView,
} from "../api.js";
import {
  INSTALL_SYSTEM_LABELS,
  type InstallSystem,
  installCommands,
  installSystems,
  probeText,
} from "../capability-install.js";
import { StatusTag, Time } from "../components/Foundation.js";
import { DialogFeedback } from "../components/layout/DialogFeedbackLayout.js";
import {
  SettingsDialogFields,
  SettingsFact,
  SettingsFacts,
  SettingsText,
  settingsDrawerDialogClassName,
  settingsDrawerOverlayClassName,
} from "../components/layout/SettingsLayout.js";
import { CAPABILITY_TAGS } from "../components/MachineDetail.js";
import {
  RequestFeedback,
  type RequestFeedbackProps,
} from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.js";
import { capabilityState, healthBlockerLabel } from "../machine-labels.js";

/** The drawer's machine check, as the install dialog may use it. */
export interface CapabilityRecheck {
  /** A human session that may start this project's machine check. */
  readonly available: boolean;
  readonly locked: boolean;
  readonly following: boolean;
  /** The last request's result is unknown: asking again goes through a confirmation. */
  readonly againable: boolean;
  readonly start: () => void;
  readonly ask: () => void;
  readonly feedback: RequestFeedbackProps;
}

/**
 * C-708: why the current project's latest check did not verify a capability,
 * from what the host recorded: the check's own blockers, the fixed failure
 * text or search labels it kept, or that the probe did not succeed. Command
 * output is never kept by the host, so it is never shown.
 */
const searchedAll = (
  probe: MachineCapabilityView["probe"],
  searched: readonly string[],
) =>
  probe?.kind === "search" &&
  probe.locations.every((location) => searched.includes(location));

export function capabilityCheckResult(
  binding: MachineBindingView | undefined,
  key: string,
): string | undefined {
  const capability = binding?.capabilities.find((c) => c.key === key);
  const state = capability ? capabilityState(capability) : "unverified";
  if (state === "verified") return undefined;
  const health = binding?.machine_check;
  if (!health) return "尚未检查";
  if (health.status === "checking") return "检查中";
  if (health.status === "failed")
    return health.blockers.length
      ? `机器检查未通过：${health.blockers.map(healthBlockerLabel).join("、")}`
      : "机器检查未通过";
  if (state === "expired") return "验证已过期";
  const failure = binding?.capability_failures?.find((f) => f.key === key);
  const parts = [
    ...(failure?.reason ? [failure.reason] : []),
    ...(failure?.search_locations.length
      ? [
          // The 检测位置 fact lists them already when the search tried all.
          searchedAll(capability?.probe, failure.search_locations)
            ? "检测位置都没有找到"
            : `已查找 ${failure.search_locations.join("、")}`,
        ]
      : []),
    ...(failure?.search_incomplete ? ["查找未完成"] : []),
  ];
  return parts.length
    ? `未检出：${parts.join("；")}`
    : "未检出：检测命令未成功运行或没有输出版本号";
}

export function CapabilityInstallDialog({
  machine,
  capabilityKey,
  recheck,
  onClose,
}: {
  machine: MachineView;
  capabilityKey: string;
  recheck: CapabilityRecheck;
  onClose: () => void;
}) {
  const systems = installSystems(machine.os);
  const [system, setSystem] = useState<InstallSystem>(
    systems[0] as InstallSystem,
  );
  const [copied, setCopied] = useState<{ message?: string; error?: string }>(
    {},
  );
  const alive = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const binding = machine.bindings.find((b) => b.is_current);
  const capability = binding?.capabilities.find((c) => c.key === capabilityKey);
  const state = capability ? capabilityState(capability) : "unverified";
  const tag = CAPABILITY_TAGS[state];
  const commands = installCommands(capabilityKey, system, machine.arch) ?? "";
  const probe = probeText(capability?.probe);
  const result = capabilityCheckResult(binding, capabilityKey);
  const checked = binding?.machine_check?.checked_at;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands);
      if (alive.current) setCopied({ message: "已复制安装命令" });
    } catch {
      if (alive.current)
        setCopied({
          error: "无法写入剪贴板，请在命令框中选中文字后手动复制。",
        });
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={settingsDrawerDialogClassName}
        overlayClassName={settingsDrawerOverlayClassName}
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          // Still the 安装 button: focus moves in after this.
          opener.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          // A recheck that verified the tool removes its 安装 button.
          event.preventDefault();
          (opener.current?.isConnected
            ? opener.current
            : document.querySelector<HTMLElement>("[aria-label='关闭抽屉']")
          )?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>安装 {capabilityKey}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <SettingsDialogFields>
            <SettingsFacts>
              <SettingsFact label="机器">{machine.label}</SettingsFact>
              <SettingsFact label="状态">
                <StatusTag
                  status={tag.status}
                  label={tag.label}
                  subdued={state !== "verified"}
                />
                {capability?.version ? ` ${capability.version}` : ""}
              </SettingsFact>
              {result && (
                <SettingsFact label="检查结果">
                  {checked && (
                    <>
                      <Time value={checked} />{" "}
                    </>
                  )}
                  {result}
                </SettingsFact>
              )}
              {probe.length > 0 && (
                <SettingsFact
                  label={
                    capability?.probe?.kind === "search"
                      ? "检测位置"
                      : "检测命令"
                  }
                >
                  {probe.map((line) => (
                    <code key={line}>{line} </code>
                  ))}
                </SettingsFact>
              )}
              {binding?.runtime?.account && (
                <SettingsFact label="执行账号">
                  <code>{binding.runtime.account}</code>
                </SettingsFact>
              )}
            </SettingsFacts>
            {systems.length > 1 && (
              <fieldset>
                <legend>系统</legend>
                <ToggleGroup
                  type="multiple"
                  aria-label="系统"
                  value={[system]}
                  onValueChange={(next) => {
                    const picked = next.at(-1);
                    if (picked && systems.includes(picked as InstallSystem))
                      setSystem(picked as InstallSystem);
                  }}
                >
                  {systems.map((s) => (
                    <ToggleGroupItem key={s} value={s}>
                      {INSTALL_SYSTEM_LABELS[s]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </fieldset>
            )}
            <SettingsText aria-label="安装命令">{commands}</SettingsText>
          </SettingsDialogFields>
          <DialogFeedback>
            <RequestFeedback {...copied} />
            {recheck.available && (
              <RequestFeedback interactive {...recheck.feedback} />
            )}
          </DialogFeedback>
        </DialogBody>
        <DialogFooter>
          <Button onClick={copy}>复制命令</Button>
          <Button onClick={onClose}>关闭</Button>
          {recheck.available &&
            (recheck.againable ? (
              <Button
                variant="emphasis"
                aria-haspopup="dialog"
                onClick={recheck.ask}
              >
                仍要复查
              </Button>
            ) : (
              <Button
                variant="emphasis"
                aria-disabled={recheck.locked || undefined}
                onClick={recheck.start}
              >
                {recheck.following ? "复查中…" : "复查"}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
