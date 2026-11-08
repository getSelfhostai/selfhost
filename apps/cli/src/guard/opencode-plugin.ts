/**
 * The OpenCode plugin `selfhost guard install` writes to ~/.config/opencode/plugins/selfhost.js.
 * OpenCode has no hook settings, so before each tool call the plugin runs `selfhost hook
 * opencode` with the call on stdin and throws when the answer is not allow, which stops the call
 * and shows the reason to the model. It exports both plugin shapes from one object, as OpenCode's
 * docs describe: setup() for OpenCode 2 and server() for OpenCode 1 (1.18.29 and later).
 *
 * If selfhost cannot be run or does not answer within 10 seconds the call goes ahead (fail open),
 * as with the other agents' hooks.
 */
export function opencodePlugin(argv: readonly string[]): string {
  return `// selfhost guardrails for OpenCode. Written by \`selfhost guard install\`;
// \`selfhost guard uninstall\` removes it. Before each tool call it asks
// \`selfhost hook opencode\` and stops the call unless the answer is allow.
import { spawn } from "node:child_process";

const COMMAND = ${JSON.stringify(argv)};
const TIMEOUT_MS = 10000;
const ALLOW = { decision: "allow" };

function ask(payload) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(COMMAND[0], COMMAND.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
    } catch {
      resolve(ALLOW);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(ALLOW);
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(ALLOW);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(out.trim() === "" ? ALLOW : JSON.parse(out));
      } catch {
        resolve(ALLOW);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function check(tool, args, sessionID, callID, directory) {
  const answer = await ask({
    hook_event_name: "tool.execute.before",
    session_id: sessionID,
    call_id: callID,
    cwd: directory,
    tool_name: tool,
    tool_input: args ?? {},
  });
  if (answer && answer.decision && answer.decision !== "allow") {
    throw new Error(answer.reason || "selfhost blocked this tool call");
  }
}

export default {
  id: "selfhost",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      await check(event.tool, event.input, event.sessionID, event.callID, ctx.location?.directory);
    });
  },
  async server(input) {
    return {
      "tool.execute.before": async (event, output) => {
        await check(event.tool, output?.args, event.sessionID, event.callID, input?.directory);
      },
    };
  },
};
`;
}
