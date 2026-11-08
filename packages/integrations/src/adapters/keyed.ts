import {
  baseUrl,
  call,
  connected,
  failed,
  isCheck,
  refusedKey,
  secret,
  shown,
  unexpected,
} from "../http.js";
import type { CheckResult, Env, Fetch } from "../types.js";

/** One GET with an API key in a header: the check of a runtime with an HTTP API. */
export interface KeyedCall {
  name: string;
  url: string;
  path: string;
  keyEnv: string;
  /** The header name and its value for a key. */
  header: (key: string) => [string, string];
  /** What the key is, for messages. */
  what: string;
}

export async function keyedCheck(spec: KeyedCall, env: Env, fetch: Fetch): Promise<CheckResult> {
  const base = baseUrl(spec.url, "url");
  if (isCheck(base)) return base;
  const key = secret(env, spec.keyEnv, spec.what, "api_key_env");
  if (isCheck(key)) return key;
  const [header, value] = spec.header(key);
  const answer = await call(fetch, `${base}${spec.path}`, { headers: { [header]: value } });
  if ("status" in answer && answer.status === 200) {
    return connected(`${spec.name} at ${shown(base)} accepts the key in ${spec.keyEnv}.`);
  }
  if ("status" in answer && refusedKey(answer.status)) {
    return failed(
      `${spec.name} at ${shown(base)} refused the key in ${spec.keyEnv} (${answer.status}). It must hold ${spec.what}.`,
    );
  }
  return unexpected(answer, spec.name, base, `Check url points at the ${spec.name} API.`);
}
