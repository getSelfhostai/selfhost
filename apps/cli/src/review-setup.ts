import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentAccounts, agentLabels, agentPullCondition } from "@selfhost/attribution";
import { ReviewerSetupError, reviewerSetup, type Settings } from "@selfhost/integrations";
import { REVIEWER_TOOLS, type ReviewerTool } from "@selfhost/schema";
import type { Command } from "commander";
import { loadConfig, type ReviewIo } from "./review.js";
import { repoDir } from "./scan/index.js";

export interface ReviewSetupOptions {
  repo?: string;
  config?: string;
  model?: string;
  allPrs?: boolean;
  style?: boolean;
  appBot?: string;
  force?: boolean;
  print?: boolean;
  json?: boolean;
}

export const REVIEW_SETUP_SCHEMA = "selfhost.review_setup/v1";

type FileStatus = "written" | "replaced" | "unchanged" | "printed";

/** `selfhost review setup --json`. */
export interface ReviewSetupReport {
  schema: typeof REVIEW_SETUP_SCHEMA;
  tool: ReviewerTool;
  pull_requests: "agent" | "all";
  files: { path: string; status: FileStatus }[];
  /** Secrets the files read, by name. Their values never pass through selfhost. */
  secrets: { name: string; holds: string }[];
  next: string[];
}

function pickTool(arg: string | undefined, configured: string | undefined): ReviewerTool {
  const tool = arg ?? configured;
  if (!tool) {
    throw new Error(
      `Name the reviewer: selfhost review setup <${REVIEWER_TOOLS.join("|")}>, or set [integrations.reviewer] tool in selfhost.toml.`,
    );
  }
  if (!(REVIEWER_TOOLS as readonly string[]).includes(tool)) {
    throw new Error(`Expected a reviewer of ${REVIEWER_TOOLS.join(", ")}, got "${tool}"`);
  }
  return tool as ReviewerTool;
}

/**
 * `selfhost review setup <tool>`: writes the workflow or config file that runs an existing
 * reviewer (PR-Agent, the Claude Code GitHub Action, CodeRabbit) on the repository's agent pull
 * requests, pinned, with its key read from a repository secret it names. Settings come from
 * `[integrations.reviewer]` in selfhost.toml when it picks the same tool; flags override them.
 * An existing file that differs is kept unless --force.
 */
export async function reviewSetupCommand(
  toolArg: string | undefined,
  options: ReviewSetupOptions,
  io: ReviewIo,
): Promise<ReviewSetupReport> {
  const repo = repoDir(options.repo, io.cwd);
  if (!repo) throw new Error("Not in a git repository. Run it inside one, or pass --repo.");
  const { path: configPath, config } = loadConfig(repo, options.config, io);
  const table = config.integrations.reviewer;
  const tool = pickTool(toolArg, table?.tool);
  const { tool: _tool, ...configured } = table?.tool === tool ? table : { tool };
  const settings: Settings<"reviewer"> = {
    ...configured,
    ...(options.model ? { model: options.model } : {}),
    ...(options.allPrs ? { pull_requests: "all" as const } : {}),
    ...(options.style ? { style: true } : {}),
  };
  let setup: ReturnType<typeof reviewerSetup>;
  try {
    setup = reviewerSetup(tool, {
      settings,
      agentCondition: (labelEvents) => agentPullCondition({ labelEvents }),
      agentLabels: agentLabels(),
      agentBots: agentAccounts(),
      ...(options.appBot ? { appBot: options.appBot } : {}),
    });
  } catch (error) {
    if (error instanceof ReviewerSetupError) throw new Error(error.message);
    throw error;
  }

  const files: ReviewSetupReport["files"] = [];
  if (options.print) {
    for (const file of setup.files) files.push({ path: file.path, status: "printed" });
  } else {
    const blocked = setup.files.filter((file) => {
      const target = join(repo, file.path);
      return existsSync(target) && readFileSync(target, "utf8") !== file.text && !options.force;
    });
    if (blocked.length > 0) {
      throw new Error(
        `${blocked.map((file) => file.path).join(" and ")} already exists and differs, so nothing was written. Pass --force to replace it, or --print to see the new file.`,
      );
    }
    for (const file of setup.files) {
      const target = join(repo, file.path);
      const existed = existsSync(target);
      if (existed && readFileSync(target, "utf8") === file.text) {
        files.push({ path: file.path, status: "unchanged" });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.text);
      files.push({ path: file.path, status: existed ? "replaced" : "written" });
    }
  }

  const next = [
    ...setup.next,
    ...(table?.tool === tool
      ? []
      : [
          `Run selfhost integrations set reviewer ${tool}${configPath ? "" : " (after selfhost init)"} so selfhost checks it and the risk score waits for its review.`,
        ]),
  ];
  const report: ReviewSetupReport = {
    schema: REVIEW_SETUP_SCHEMA,
    tool,
    pull_requests: setup.pullRequests,
    files,
    secrets: setup.secrets,
    next,
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
  } else if (options.print) {
    for (const file of setup.files) {
      io.write(`# ${file.path}`);
      io.write(file.text.trimEnd());
    }
  } else {
    const words: Record<FileStatus, string> = {
      written: "Wrote",
      replaced: "Replaced",
      unchanged: "Unchanged",
      printed: "Printed",
    };
    for (const file of files) io.write(`${words[file.status]} ${file.path}`);
    io.write(
      `${setup.name} reviews ${setup.pullRequests === "agent" ? "agent pull requests only" : "every pull request"}.`,
    );
    io.write("");
    io.write("Next:");
    for (const line of next) io.write(`  - ${line}`);
  }
  return report;
}

export function registerReviewSetup(
  program: Command,
  io: () => ReviewIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const review =
    program.commands.find((command) => command.name() === "review") ??
    program.command("review").description("score and route agent pull requests");

  review
    .command("setup")
    .description(
      `wire an existing AI reviewer (${REVIEWER_TOOLS.join(", ")}) into this repository: writes its pinned workflow or config, reading its key from a repository secret`,
    )
    .argument("[tool]", "the reviewer (default: [integrations.reviewer] tool in selfhost.toml)")
    .option("--repo <dir>", "git repository (default: the one here)")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--model <id>", "the model the reviewer runs (overrides [integrations.reviewer] model)")
    .option("--all-prs", "review every pull request, not only agent pull requests")
    .option("--style", "let the reviewer comment on style, formatting and naming")
    .option(
      "--app-bot <login>",
      "the selfhost GitHub App's bot login, so the Claude Code action runs when the App labels a pull request",
    )
    .option("--force", "replace a file that already exists and differs")
    .option("--print", "print the file instead of writing it")
    .option("--json", "print JSON")
    .action(async (tool: string | undefined, options: ReviewSetupOptions) => {
      try {
        await reviewSetupCommand(tool, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
