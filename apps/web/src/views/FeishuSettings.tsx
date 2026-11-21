import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CardiganClient, FeishuBindingView } from "../api.js";
import { StatusTag } from "../components/Foundation.js";
import {
  SettingsGroup,
  SettingsPanel,
  SettingsRow,
} from "../components/layout/SettingsLayout.js";
import {
  RequestFeedback,
  useFeedbackVisible,
} from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { useResource } from "../useResource.js";
import { trackSettingsRead, useSettingWrite } from "./useSettingWrite.js";

// /api/me/feishu addresses one binding regardless of the settings page's project.
const bindingWriteKey = Symbol("feishu-binding");

function bindingUnavailableReason(state: string | undefined) {
  switch (state) {
    case undefined:
      return "读取中";
    case "disabled":
      return "未启用";
    case "connecting":
      return "连接中";
    case "reconnecting":
      return "重连中";
    case "connected":
      return undefined;
    default:
      return "离线";
  }
}

export function FeishuSettings({ client }: { client: CardiganClient }) {
  const title = useId(),
    visible = useFeedbackVisible();
  const [confirm, setConfirm] = useState(false);
  // The one-time code belongs only to the view that requested it, never the shared save notice.
  const [grant, setGrant] =
    useState<Pick<FeishuBindingView, "code" | "expires">>();
  const [expired, setExpired] = useState(false);
  const visit = useRef(0),
    cancelButton = useRef<HTMLButtonElement>(null),
    unlinkButton = useRef<HTMLButtonElement>(null);
  const load = useCallback(async () => {
    if (!client.feishuBinding) throw new Error("绑定服务不可用");
    return trackSettingsRead(client.feishuBinding());
  }, [client]);
  const resource = useResource(load, 0, visible);
  const data = resource.data;
  const save = useSettingWrite({
    name: "飞书绑定",
    sharedWriteKey: bindingWriteKey,
    uncertainMessage: "请先刷新确认绑定状态；如仍需绑定，请重新生成绑定码。",
    server: data?.bound,
    source: data,
    confirmable: !!data,
    failure: (bind) => (bind ? "未能生成飞书绑定码" : "未能解除飞书绑定"),
    success: (bind) => (bind ? "已生成飞书绑定码" : "已解除飞书绑定"),
    saved: () => {
      if (visible) resource.refresh();
    },
    write: async (bind) => {
      const at = visit.current;
      if (!client.feishuBinding) throw new Error("绑定服务不可用");
      // Regeneration may have invalidated the previous code even if its response is lost.
      setGrant(undefined);
      setExpired(false);
      const result = await client.feishuBinding(bind ? "code" : "unbind");
      if (at !== visit.current) return;
      if (result.code && result.expires)
        setGrant({ code: result.code, expires: result.expires });
      setConfirm(false);
      resource.replace({ state: result.state, bound: result.bound });
      resource.refresh();
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing view invalidates an outstanding one-time-code response.
  useEffect(() => {
    return () => {
      visit.current++;
    };
  }, [visible, client]);
  useEffect(() => {
    if (!visible || data?.bound || data?.state !== "connected") {
      setGrant(undefined);
      setExpired(false);
    }
    if (!visible || !data?.bound) setConfirm(false);
  }, [visible, data?.state, data?.bound]);
  useEffect(() => {
    if (!visible || resource.pending || save.saving) return;
    const timer = setInterval(resource.refresh, 3000);
    return () => clearInterval(timer);
  }, [visible, resource.pending, resource.refresh, save.saving]);
  useEffect(() => {
    if (!grant?.expires) return;
    const timer = setTimeout(
      () => {
        setGrant(undefined);
        setExpired(true);
      },
      Math.max(0, grant.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [grant]);
  const restore = useRef(false);
  useEffect(() => {
    if (confirm) cancelButton.current?.focus();
    else if (restore.current) {
      unlinkButton.current?.focus();
      restore.current = false;
    }
  }, [confirm]);
  const cancel = () => {
    if (save.busy) return;
    save.clear();
    restore.current = true;
    setConfirm(false);
  };
  const unavailableReason = bindingUnavailableReason(data?.state);
  const label = data?.bound
    ? "已绑定"
    : (unavailableReason ??
      (grant?.code ? "等待飞书确认" : expired ? "绑定码已过期" : "未绑定"));
  const busyOrStale = save.busy || !!resource.error;
  return (
    <SettingsPanel title="飞书绑定" titleId={title} hidden={!visible}>
      <SettingsGroup title="应用机器人">
        <SettingsRow
          label="绑定状态"
          status={
            <StatusTag
              status={data?.bound ? "done" : "pending"}
              label={label}
            />
          }
        >
          {data?.bound ? (
            confirm ? (
              <>
                <Button
                  variant="destructive"
                  aria-disabled={save.busy}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancel();
                  }}
                  onClick={() => {
                    if (!save.busy) void save.save(false);
                  }}
                >
                  确认解绑
                </Button>
                <Button
                  ref={cancelButton}
                  aria-disabled={save.busy}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancel();
                  }}
                  onClick={cancel}
                >
                  取消
                </Button>
              </>
            ) : (
              <Button
                ref={unlinkButton}
                aria-disabled={save.busy || !!resource.error}
                onClick={() => {
                  if (!save.busy && !resource.error) {
                    save.clear();
                    setConfirm(true);
                  }
                }}
              >
                解除绑定
              </Button>
            )
          ) : (
            <Button
              disabled={!!unavailableReason}
              aria-disabled={!!unavailableReason || busyOrStale}
              data-disabled={busyOrStale || undefined}
              title={unavailableReason}
              onClick={() => {
                if (!unavailableReason && !busyOrStale) void save.save(true);
              }}
            >
              {grant?.code ? "重新生成" : "绑定飞书"}
            </Button>
          )}
        </SettingsRow>
        {grant?.code && (
          <SettingsRow
            label="私聊发送给应用机器人"
            help="绑定码只显示一次，过期后请重新生成。"
          >
            <code className="break-all">{grant.code}</code>
          </SettingsRow>
        )}
      </SettingsGroup>
      <RequestFeedback
        interactive={save.saving}
        pending={save.saving || resource.pending}
        pendingMessage={save.saving ? "正在更新飞书绑定…" : "正在读取绑定状态…"}
        message={save.message}
        error={
          save.error ||
          (resource.error
            ? `未能读取飞书绑定状态：${resource.error}`
            : undefined)
        }
        retry={resource.error ? resource.reload : undefined}
      />
    </SettingsPanel>
  );
}
