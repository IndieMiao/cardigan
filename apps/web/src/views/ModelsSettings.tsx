import { useCallback, useState } from "react";
import type {
  CardiganClient,
  LaunchModelMetadata,
  LaunchProfileCheck,
  LaunchProfileReference,
  LaunchProfileView,
  LaunchProviderView,
} from "../api.js";
import { Drawer } from "../components/Drawer.js";
import { EmptyState, StatusTag, Time } from "../components/Foundation.js";
import { CardDetailLayout } from "../components/layout/CardDetailLayout.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsFact,
  SettingsFacts,
  SettingsPanel,
  SettingsSection,
  SettingsTable,
  settingsDrawerClassName,
  useDrawerReturnFocus,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { routeHash } from "../route.js";
import { useResource } from "../useResource.js";

/**
 * C-518: global launch profiles (C-515 read contract), read-only. Secret values
 * are never in the response; only key names and whether each one is set.
 */
export function ModelsSettings({
  client,
  projectId,
}: {
  client: CardiganClient;
  projectId: string;
}) {
  const load = useCallback(() => client.launchSettings(), [client]);
  const settings = useResource(load);
  // The clicked row of this response: names may be redacted to the same mask.
  const [open, setOpen] = useState<number>();
  const { remember } = useDrawerReturnFocus(open !== undefined);
  const data = settings.data;
  const profile = open === undefined ? undefined : data?.profiles[open];
  return (
    <SettingsPanel
      id="models"
      tabIndex={-1}
      title="模型"
      titleId="models-title"
    >
      <RequestFeedback
        {...settings}
        retry={settings.reload}
        pendingMessage="正在加载启动配置…"
      />
      {data && data.profiles.length === 0 && (
        <EmptyState>没有启动配置</EmptyState>
      )}
      {data && data.profiles.length > 0 && (
        <SettingsTable aria-label="启动配置">
          <TableHeader>
            <TableRow>
              <TableHead>配置</TableHead>
              <TableHead>Harness</TableHead>
              <TableHead>模型</TableHead>
              <TableHead>参数</TableHead>
              <TableHead>密钥</TableHead>
              <TableHead>引用</TableHead>
              <TableHead>最近检查</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.profiles.map((p, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: names are not unique once redacted; the response order is the identity.
              <TableRow key={index}>
                <DataTableCell data-record="lead">
                  <Button
                    variant="link"
                    aria-haspopup="dialog"
                    onClick={() => {
                      remember();
                      setOpen(index);
                    }}
                  >
                    {p.name}
                  </Button>
                </DataTableCell>
                <DataTableCell nowrap data-label="Harness">
                  {p.harness}
                </DataTableCell>
                <DataTableCell data-label="模型">
                  <ModelName profile={p} />
                </DataTableCell>
                <DataTableCell data-label="参数">
                  {parameterSummary(p.parameters)}
                </DataTableCell>
                <DataTableCell nowrap data-label="密钥">
                  {secretSummary(p.secrets)}
                </DataTableCell>
                <DataTableCell nowrap data-label="引用">
                  {p.references.length}
                </DataTableCell>
                <DataTableCell nowrap data-record="aside">
                  <CheckStatus check={p.last_check} />
                </DataTableCell>
              </TableRow>
            ))}
          </TableBody>
        </SettingsTable>
      )}
      {profile && (
        <ProfileDetail
          profile={profile}
          provider={data?.providers.find((v) => v.id === profile.provider)}
          projectId={projectId}
          onClose={() => setOpen(undefined)}
        />
      )}
    </SettingsPanel>
  );
}

function ModelName({ profile }: { profile: LaunchProfileView }) {
  if (!profile.model_id) return <>—</>;
  return profile.model_alias && profile.model_alias !== profile.model_id ? (
    <>
      {profile.model_alias} → <code>{profile.model_id}</code>
    </>
  ) : (
    <code>{profile.model_id}</code>
  );
}

const parameterSummary = (p: LaunchProfileView["parameters"]) => {
  const parts = [
    p.effort && `effort ${p.effort}`,
    p.permission_mode,
    p.provider_flag && `provider ${p.provider_flag}`,
    p.auto_update !== null && (p.auto_update ? "自动更新" : "不自动更新"),
    p.custom_args_count > 0 && `自定义参数 ${p.custom_args_count}`,
    p.custom_config_count > 0 && `自定义配置 ${p.custom_config_count}`,
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "—";
};

const secretSummary = (secrets: LaunchProfileView["secrets"]) => {
  if (secrets.length === 0) return "—";
  const missing = secrets.filter((s) => !s.set).length;
  return missing ? `${missing} 项未设置` : "已设置";
};

const checkLabels: Record<LaunchProfileCheck["status"], string> = {
  passed: "通过",
  failed: "未通过",
  running: "检查中",
  interrupted: "已中断",
};
function CheckStatus({ check }: { check: LaunchProfileCheck | null }) {
  return check ? (
    <StatusTag status={check.status} label={checkLabels[check.status]} />
  ) : (
    <StatusTag status="not_run" label="未检查" />
  );
}

const count = new Intl.NumberFormat("zh-CN");
const tokens = (value: number | undefined) =>
  value === undefined ? "—" : `${count.format(value)} tokens`;
const price = (cost: LaunchModelMetadata["cost"]) =>
  cost ? `输入 $${cost.input} · 输出 $${cost.output}（每百万 tokens）` : "—";
const list = (values: readonly string[] | undefined) =>
  values?.length ? values.join("、") : "—";

function ProfileDetail({
  profile,
  provider,
  projectId,
  onClose,
}: {
  profile: LaunchProfileView;
  provider: LaunchProviderView | undefined;
  projectId: string;
  onClose: () => void;
}) {
  const meta = profile.metadata;
  return (
    <Drawer
      className={settingsDrawerClassName}
      open
      onOpenChange={(next) => !next && onClose()}
      title={profile.name}
      description={`启动配置 ${profile.name} 详情`}
      initialFocus="close"
    >
      <CardDetailLayout
        className="card-page-drawer"
        aria-label={`启动配置 ${profile.name}`}
      >
        <SettingsSection title="配置">
          <SettingsFacts>
            <SettingsFact label="Harness">{profile.harness}</SettingsFact>
            <SettingsFact label="Provider">
              {provider ? (
                <>
                  {provider.name} <code>{provider.id}</code>
                </>
              ) : (
                (profile.provider ?? "—")
              )}
            </SettingsFact>
            <SettingsFact label="端点">
              {provider?.base_url ? <code>{provider.base_url}</code> : "—"}
            </SettingsFact>
            <SettingsFact label="模型别名">
              {profile.model_alias ?? "—"}
            </SettingsFact>
            <SettingsFact label="模型标识">
              {profile.model_id ? <code>{profile.model_id}</code> : "—"}
            </SettingsFact>
            <SettingsFact label="参数">
              {parameterSummary(profile.parameters)}
            </SettingsFact>
            <SettingsFact label="CLI 版本">
              {profile.cli.version ?? "—"}
            </SettingsFact>
            <SettingsFact label="CLI 路径">
              {profile.cli.path ? <code>{profile.cli.path}</code> : "—"}
            </SettingsFact>
          </SettingsFacts>
        </SettingsSection>
        <SettingsSection title="模型元数据">
          <SettingsFacts>
            <SettingsFact label="上下文窗口">
              {tokens(meta?.context_window)}
            </SettingsFact>
            <SettingsFact label="最大输出">
              {tokens(meta?.max_output_tokens)}
            </SettingsFact>
            <SettingsFact label="价格">{price(meta?.cost)}</SettingsFact>
            <SettingsFact label="推理强度">
              {list(meta?.reasoning_efforts)}
            </SettingsFact>
          </SettingsFacts>
        </SettingsSection>
        <SettingsSection title="密钥">
          {profile.secrets.length === 0 ? (
            <EmptyState>不需要密钥</EmptyState>
          ) : (
            <SettingsFacts>
              {profile.secrets.map((s) => (
                <SettingsFact key={s.key} label={<code>{s.key}</code>}>
                  <StatusTag
                    status={s.set ? "passed" : "blocked"}
                    label={s.set ? "已设置" : "未设置"}
                  />
                </SettingsFact>
              ))}
            </SettingsFacts>
          )}
        </SettingsSection>
        <SettingsSection title="最近检查">
          {profile.last_check ? (
            <LastCheck check={profile.last_check} />
          ) : (
            <EmptyState>未检查</EmptyState>
          )}
        </SettingsSection>
        <SettingsSection title="使用者">
          {profile.references.length === 0 ? (
            <EmptyState>没有角色或员工使用</EmptyState>
          ) : (
            <References refs={profile.references} projectId={projectId} />
          )}
        </SettingsSection>
      </CardDetailLayout>
    </Drawer>
  );
}

function LastCheck({ check }: { check: LaunchProfileCheck }) {
  return (
    <SettingsFacts>
      <SettingsFact label="结果">
        <CheckStatus check={check} />
      </SettingsFact>
      <SettingsFact label="方式">
        {check.mode === "online" ? "在线探测" : "本地检查"}
      </SettingsFact>
      <SettingsFact label="开始">
        <Time value={check.started_at} />
      </SettingsFact>
      <SettingsFact label="完成">
        {check.finished_at ? <Time value={check.finished_at} /> : "—"}
      </SettingsFact>
      <SettingsFact label="CLI 版本">{check.cli_version ?? "—"}</SettingsFact>
      <SettingsFact label="问题">
        {check.problems.length
          ? check.problems.map((p) => <code key={p}>{p} </code>)
          : "—"}
      </SettingsFact>
    </SettingsFacts>
  );
}

/** Roles open the referenced version in that project's settings; employees their work on the execution page. */
function References({
  refs,
  projectId,
}: {
  refs: readonly LaunchProfileReference[];
  projectId: string;
}) {
  return (
    <SettingsTable aria-label="使用者">
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>编号</TableHead>
          <TableHead>项目</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {refs.map((ref) =>
          "role_id" in ref ? (
            <TableRow
              key={`role:${ref.project_id}:${ref.role_id}:${ref.version}`}
            >
              <DataTableCell data-record="lead">
                <Button asChild variant="link">
                  <a
                    href={routeHash({
                      kind: "settings",
                      projectId: ref.project_id,
                      filters: {
                        tab: "roles",
                        role: ref.role_id,
                        version: String(ref.version),
                      },
                    })}
                  >
                    {ref.name}
                  </a>
                </Button>
              </DataTableCell>
              <DataTableCell nowrap data-label="类型">
                角色
              </DataTableCell>
              <DataTableCell nowrap data-label="编号">
                <code>{ref.role_id}</code> v{ref.version}
              </DataTableCell>
              <DataTableCell nowrap data-record="aside">
                {ref.project_id}
              </DataTableCell>
            </TableRow>
          ) : (
            <TableRow key={`employee:${ref.employee_id}`}>
              <DataTableCell data-record="lead">
                <Button asChild variant="link">
                  <a
                    href={routeHash({
                      kind: "execution",
                      projectId,
                      // Exact employee, any status: idle employees still land on their records.
                      filters: { view: "all", employee: ref.employee_id },
                    })}
                  >
                    {ref.name}
                  </a>
                </Button>
              </DataTableCell>
              <DataTableCell nowrap data-label="类型">
                员工
              </DataTableCell>
              <DataTableCell nowrap data-label="编号">
                <code>{ref.employee_id}</code>
              </DataTableCell>
              <DataTableCell nowrap data-record="aside">
                全局
              </DataTableCell>
            </TableRow>
          ),
        )}
      </TableBody>
    </SettingsTable>
  );
}
