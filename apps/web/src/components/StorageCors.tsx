import type { StorageCorsBlock } from "../api.js";
import { SettingsFact, SettingsFacts } from "./layout/SettingsLayout.js";

/** C-807: why browser uploads fail, as the page heading says it. */
export const STORAGE_CORS_TITLE = "存储桶未允许本站跨域上传";

export const storageCorsReason = (block: StorageCorsBlock) =>
  block.reason === "not_enabled"
    ? "存储桶没有开启跨域（CORS）"
    : "跨域规则不包含本站来源、方法或请求头";

/** The refusal and the rule to add in the OSS console (cross-origin settings). */
export function StorageCorsRule({ block }: { block: StorageCorsBlock }) {
  return (
    <SettingsFacts>
      <SettingsFact label="原因">{storageCorsReason(block)}</SettingsFact>
      <SettingsFact label="来源">
        {block.rule.origins.map((origin) => (
          <div key={origin}>
            <code>{origin}</code>
          </div>
        ))}
      </SettingsFact>
      <SettingsFact label="方法">{block.rule.methods.join("、")}</SettingsFact>
      <SettingsFact label="允许头">
        {block.rule.headers.map((h, i) => (
          <span key={h}>
            {i > 0 && "、"}
            <code>{h}</code>
          </span>
        ))}
      </SettingsFact>
    </SettingsFacts>
  );
}
