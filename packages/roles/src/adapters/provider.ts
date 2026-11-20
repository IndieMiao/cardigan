import type { ProviderDefinition } from "../schema-definition.js";
export function validateSecretKey(
  at: string,
  id: string,
  provider: ProviderDefinition,
  selected: string | undefined,
  login: boolean,
  details: string[],
) {
  if (selected && !Object.hasOwn(provider.secret_env, selected))
    details.push(`${at}.${id}.env_key 必须引用此接入点的 secret_env`);
  if (!selected && !login && Object.keys(provider.secret_env).length > 1)
    details.push(`${at}.${id}.env_key: 多个凭据引用需要显式选择`);
}
export function onlyKey(keys: string[]) {
  return keys.length === 1 ? keys[0] : undefined;
}
