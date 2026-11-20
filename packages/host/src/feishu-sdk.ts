import { createRequire } from "node:module";
import type { HttpInstance } from "@larksuiteoapi/node-sdk";

const requireSdk = createRequire(import.meta.url);
// Keep the optional integration (and its large API client) off normal CLI startup.
export const feishuSdk = (): typeof import("@larksuiteoapi/node-sdk") =>
  requireSdk("@larksuiteoapi/node-sdk");
const discard = () => {};
export const privateSdkLogger = {
  error: discard,
  warn: discard,
  info: discard,
  debug: discard,
  trace: discard,
};
/** The SDK expects the response data, not AxiosResponse. Its bundled axios types
 * do not reflect the transformed result after installing a response interceptor. */
export function privateSdkHttp(timeout: number): HttpInstance {
  const http = feishuSdk().defaultHttpInstance.create({
    timeout,
    maxRedirects: 0,
  });
  http.interceptors.response.use((r) => r.data);
  return http as unknown as HttpInstance;
}
