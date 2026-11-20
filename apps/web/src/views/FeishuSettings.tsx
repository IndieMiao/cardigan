import { useEffect, useId, useRef, useState } from "react";
import type { CardiganClient, FeishuBindingView } from "../api.js";
import {
  SettingsGroup,
  SettingsPanel,
  SettingsRow,
} from "../components/layout/SettingsLayout.js";
import { Button } from "../components/ui/button.js";
export function FeishuSettings({ client }: { client: CardiganClient }) {
  const [data, setData] = useState<FeishuBindingView>(),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const revision = useRef(0),
    title = useId();
  useEffect(() => {
    let active = true,
      reading = false;
    const fetch = async () => {
      if (reading) return;
      reading = true;
      const seq = revision.current;
      try {
        const d = await client.feishuBinding?.();
        if (active && d && seq === revision.current) {
          setError((old) => (old === "无法读取绑定状态" ? "" : old));
          setData((old) =>
            d.state === "connected" && !d.bound && old?.code
              ? { ...old, ...d }
              : d,
          );
        }
      } catch {
        if (active) setError("无法读取绑定状态");
      } finally {
        reading = false;
      }
    };
    void fetch();
    const timer = setInterval(() => {
      void fetch();
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client]);
  useEffect(() => {
    if (!data?.expires) return;
    const timer = setTimeout(
      () => {
        setExpired(true);
        setData((d) => d && { state: d.state, bound: d.bound });
      },
      Math.max(0, data.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [data?.expires]);
  async function write(action: "code" | "unbind") {
    if (!client.feishuBinding || busy) return;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      const d = await client.feishuBinding(action);
      setData(d);
      setConfirm(false);
      setExpired(false);
    } catch {
      setError(action === "code" ? "未能生成绑定码" : "解绑失败");
    } finally {
      revision.current++;
      setBusy(false);
    }
  }
  const label = !data
    ? "读取中"
    : data.bound
      ? "已绑定"
      : data.code
        ? "等待飞书确认"
        : expired
          ? "绑定码已过期"
          : data.state === "disabled"
            ? "未启用"
            : data.state !== "connected"
              ? "未连接"
              : "未绑定";
  return (
    <SettingsPanel title="飞书绑定" titleId={title}>
      <SettingsGroup title="应用机器人">
        <SettingsRow
          label="绑定状态"
          status={<span role="status">{label}</span>}
        >
          {data?.bound ? (
            confirm ? (
              <>
                <Button disabled={busy} onClick={() => void write("unbind")}>
                  确认解绑
                </Button>
                <Button onClick={() => setConfirm(false)}>取消</Button>
              </>
            ) : (
              <Button onClick={() => setConfirm(true)}>解除绑定</Button>
            )
          ) : (
            <Button
              disabled={busy || data?.state !== "connected"}
              onClick={() => void write("code")}
            >
              {data?.code ? "重新生成" : "绑定飞书"}
            </Button>
          )}
        </SettingsRow>
        {data?.code && (
          <SettingsRow
            label="私聊发送给应用机器人"
            help="绑定码只显示一次，过期后请重新生成。"
          >
            <code className="break-all">{data.code}</code>
          </SettingsRow>
        )}
        {error && <p role="alert">{error}</p>}
      </SettingsGroup>
    </SettingsPanel>
  );
}
