import { readFileSync, statSync } from "node:fs";
import { locate } from "./locations.js";
import type { AgentId, Env, KeychainCheck } from "./types.js";

/** A subscription login found for an agent: its model traffic goes to the vendor directly. */
export interface SubscriptionLogin {
  /** The plan family, for people: "a Claude plan", "a ChatGPT plan". */
  plan: string;
  /** The file, keychain service or environment variable that shows it. */
  source: string;
}

export interface SubscriptionOptions {
  home: string;
  env?: Env;
  platform?: NodeJS.Platform;
  keychain?: KeychainCheck;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The JSON object in a file, or undefined. Only the shape is looked at; no value leaves here. */
function readObject(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const set = (env: Env, name: string) => (env[name] ?? "").trim() !== "";

/**
 * Finds a subscription login for an agent: a Claude account login for Claude Code (Pro, Max,
 * Team or Enterprise plans bill there), a ChatGPT login for Codex, or an OAuth login to Anthropic
 * or OpenAI in OpenCode. Such traffic goes to the vendor and never reaches a gateway. No secret
 * is read: only whether a credential exists, and for files the kind of login they hold. Goose
 * and Cursor return null: Goose's own providers take API keys, and Cursor can't use a gateway.
 */
export function subscriptionLogin(
  agent: AgentId,
  { home, env = {}, platform = process.platform, keychain }: SubscriptionOptions,
): SubscriptionLogin | null {
  const loc = locate({ home, env, platform });
  switch (agent) {
    case "claude_code": {
      const plan = "a Claude account (Pro, Max, Team or Enterprise plan)";
      if (set(env, "CLAUDE_CODE_OAUTH_TOKEN")) return { plan, source: "CLAUDE_CODE_OAUTH_TOKEN" };
      if (isFile(loc.claude_code.credentials)) return { plan, source: loc.claude_code.credentials };
      if (platform === "darwin" && keychain?.(loc.claude_code.keychainService)) {
        return { plan, source: `keychain item ${loc.claude_code.keychainService}` };
      }
      return null;
    }
    case "codex": {
      const plan = "a ChatGPT plan";
      const auth = readObject(loc.codex.auth);
      if (auth) {
        const mode = typeof auth.auth_mode === "string" ? auth.auth_mode.toLowerCase() : "";
        const tokens = auth.tokens !== null && typeof auth.tokens === "object";
        return mode.includes("chatgpt") || (mode === "" && tokens)
          ? { plan, source: loc.codex.auth }
          : null;
      }
      // A keychain login can't be told apart from an API key without reading it.
      const { keychainService, keychainAccount } = loc.codex;
      if (platform === "darwin" && keychain?.(keychainService, keychainAccount)) {
        return { plan: "a ChatGPT plan or an API key", source: `keychain item ${keychainService}` };
      }
      return null;
    }
    case "opencode": {
      const auth = readObject(loc.opencode.auth) ?? {};
      const oauth = ["anthropic", "openai"].filter((provider) => {
        const entry = auth[provider];
        return entry && typeof entry === "object" && (entry as { type?: unknown }).type === "oauth";
      });
      if (oauth.length === 0) return null;
      const plans = oauth.map((p) => (p === "anthropic" ? "a Claude plan" : "a ChatGPT plan"));
      return { plan: plans.join(" and "), source: loc.opencode.auth };
    }
    case "goose":
    case "cursor":
      return null;
  }
}
