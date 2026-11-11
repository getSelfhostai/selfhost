import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findTranscript, placeTranscript, type TranscriptAgent } from "@selfhost/importers";
import {
  HANDOFF_TRANSCRIPT_MAX_BYTES,
  HANDOFF_TURNS_MAX,
  type Handoff,
  type RunShareResponse,
  redactTranscript,
  TRANSCRIPT_VENDORS,
  type TranscriptUpload,
} from "@selfhost/schema";
import type { Command } from "commander";
import { refuseAgentSession } from "../human.js";
import { type Fetch, TeamClient } from "../team/client.js";
import { type Membership, readMembership } from "../team/config.js";
import { agentName, BRIEF_DIR, briefPath, type ResumePlan, renderBrief } from "./brief.js";
import {
  type CheckoutResult,
  checkoutBranch,
  excludeLocally,
  type Git,
  gitTop,
  originRepo,
  systemGit,
  workState,
} from "./git.js";

export interface HandoffIo {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  /** ~/.selfhost/config.json: the team membership. */
  configPath: string;
  fetch: Fetch;
  /** The home folder the agents keep their transcripts under. Default: the real one. */
  home?: string;
  /** Runs git; tests pass the real one over temporary repositories. */
  git?: Git;
  now?: Date;
}

export interface ShareOptions {
  /** false with --no-comment. */
  comment?: boolean;
  json?: boolean;
}

export interface HandoffOptions {
  to: string;
  note?: string;
  turns?: string;
  /** false with --no-transcript. */
  transcript?: boolean;
  repo?: string;
  json?: boolean;
}

export interface TakeoverOptions {
  repo?: string;
  /** Print the brief instead of writing it, and change nothing in the clone. */
  print?: boolean;
  json?: boolean;
}

/** What happened to the agent's transcript on a handoff. */
export type TranscriptOutcome =
  | "sent"
  | "team_off"
  | "declined"
  | "unsupported_agent"
  | "not_found"
  | "too_large";

/** `selfhost handoff --json`. */
export interface HandoffReport {
  schema: "selfhost.handoff_result/v1";
  handoff: Handoff;
  transcript: TranscriptOutcome;
  /** What did not travel or could not be checked, one line each. */
  warnings: string[];
}

/** `selfhost takeover --json`. */
export interface TakeoverReport {
  schema: "selfhost.takeover_result/v1";
  handoff: Handoff;
  /** The clone the run continues in; null with --print or outside one. */
  repo_dir: string | null;
  checkout: CheckoutResult | null;
  /** The brief's path in the clone; null with --print. */
  brief_path: string | null;
  /** Where the transcript was put for the agent's own resume; null without one. */
  transcript_path: string | null;
  resume: ResumePlan;
  warnings: string[];
}

function team(io: HandoffIo, what: string): { membership: Membership; client: TeamClient } {
  const membership = readMembership(io.configPath);
  if (!membership) {
    throw new Error(
      `${what} goes through the team server, which holds the run's record and the new owner's access. Join a team first: selfhost join <server> <invite>`,
    );
  }
  return {
    membership,
    client: new TeamClient(membership.server, membership.token, io.fetch),
  };
}

const isTranscriptAgent = (vendor: string | undefined): vendor is TranscriptAgent =>
  (TRANSCRIPT_VENDORS as readonly string[]).includes(vendor ?? "");

const short = (id: string) => id.slice(0, 8);

/** `selfhost share <session>`: the run's stable link, posted on its pull requests by the App. */
export async function runShare(
  session: string,
  options: ShareOptions,
  io: HandoffIo,
): Promise<RunShareResponse> {
  const { client } = team(io, "Sharing a run");
  const shared = await client.shareRun(session, { comment: options.comment !== false });
  if (options.json) {
    io.write(JSON.stringify(shared, null, 2));
    return shared;
  }
  io.write(shared.url);
  io.write("Opens the run's timeline for people signed in to the team; secrets stay masked.");
  for (const comment of shared.comments) {
    if (comment.action === "failed") {
      io.write(`Could not post on ${comment.pr}: ${comment.error ?? "unknown error"}`);
      io.setExitCode(1);
    } else {
      io.write(`${comment.action === "unchanged" ? "Already on" : "Posted on"} ${comment.pr}`);
    }
  }
  if (shared.skipped && options.comment !== false) io.write(shared.skipped);
  return shared;
}

/** The clone to read git from: --repo, else the run's own directory when it is here, else cwd. */
function cloneOf(git: Git, given: string | undefined, runCwd: string | undefined, cwd: string) {
  if (given) {
    const top = gitTop(git, given);
    if (!top) throw new Error(`--repo: ${given} is not in a git repository`);
    return top;
  }
  if (runCwd && existsSync(runCwd)) {
    const top = gitTop(git, runCwd);
    if (top) return top;
  }
  return gitTop(git, cwd);
}

/**
 * `selfhost handoff <session> --to <person>`: gives a run to a teammate. The server checks who
 * may and records the owner change; this machine adds the branch, the commit and what has not
 * left it, and the agent's transcript when the team shares transcripts, masked first.
 */
export async function runHandoff(
  session: string,
  options: HandoffOptions,
  io: HandoffIo,
): Promise<HandoffReport> {
  refuseAgentSession("selfhost handoff", io.env);
  const turns = options.turns === undefined ? undefined : Number(options.turns);
  if (turns !== undefined && (!Number.isInteger(turns) || turns < 1 || turns > HANDOFF_TURNS_MAX)) {
    throw new Error(`--turns: expected a whole number from 1 to ${HANDOFF_TURNS_MAX}`);
  }
  const { client } = team(io, "Handing a run over");
  const git = io.git ?? systemGit;
  const run = await client.agentRun(session, 20);
  const started = run.events.find((event) => event.kind === "session.started");
  const runCwd = typeof started?.data?.cwd === "string" ? started.data.cwd : undefined;
  const warnings: string[] = [];

  const top = cloneOf(git, options.repo, runCwd, io.cwd);
  let state: ReturnType<typeof workState> | undefined;
  if (top) {
    const origin = originRepo(git, top);
    if (run.run.repo && origin && origin.toLowerCase() !== run.run.repo.toLowerCase()) {
      throw new Error(
        `This clone is ${origin}, and the run worked in ${run.run.repo}. Run it in that clone, or pass --repo <dir>.`,
      );
    }
    state = workState(git, top);
    if (!state.branch) warnings.push("HEAD is detached: no branch was named for the new owner.");
    if (state.pushed === false) {
      warnings.push(
        `${state.branch} has commits its upstream does not: push them (git push) so the new owner can fetch them.`,
      );
    } else if (state.pushed === undefined && state.branch) {
      warnings.push(
        `${state.branch} tracks no upstream: push it (git push -u origin ${state.branch}) so the new owner can fetch it.`,
      );
    }
    if (state.uncommitted.length > 0) {
      warnings.push(
        `${state.uncommitted.length} file(s) have changes that are not committed; they stay on this machine.`,
      );
    }
  } else {
    warnings.push("Not in a git clone of the run's repository: no branch or commit was recorded.");
  }

  const vendor = run.run.agent?.vendor;
  let transcript: TranscriptUpload | undefined;
  let outcome: TranscriptOutcome;
  const policy = run.run.team ? await client.policy(run.run.team) : undefined;
  if (policy?.config.handoff?.share_transcript !== true) {
    outcome = "team_off";
  } else if (options.transcript === false) {
    outcome = "declined";
  } else if (!isTranscriptAgent(vendor)) {
    outcome = "unsupported_agent";
  } else {
    const path = findTranscript(vendor, session, { env: io.env, home: io.home ?? homedir() });
    if (!path) {
      outcome = "not_found";
    } else if (statSync(path).size > HANDOFF_TRANSCRIPT_MAX_BYTES) {
      outcome = "too_large";
    } else {
      const text = redactTranscript(readFileSync(path, "utf8"), policy.config.redaction ?? []).text;
      transcript = { vendor, file_name: basename(path), text };
      outcome = "sent";
    }
  }

  const handoff = await client.handOff(session, {
    to: options.to,
    ...(options.note ? { note: options.note } : {}),
    ...(state?.branch ? { branch: state.branch } : {}),
    ...(state?.commit ? { commit: state.commit } : {}),
    ...(state?.pushed !== undefined ? { pushed: state.pushed } : {}),
    ...(state && state.uncommitted.length > 0 ? { uncommitted: state.uncommitted } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(transcript ? { transcript } : {}),
  });
  const report: HandoffReport = {
    schema: "selfhost.handoff_result/v1",
    handoff,
    transcript: outcome,
    warnings,
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  io.write(`Handed ${agentName(handoff)} run ${short(session)} to ${handoff.to}.`);
  io.write(`  Owner in the ledger: ${handoff.from} -> ${handoff.to} at ${handoff.created_at}`);
  if (handoff.branch) {
    io.write(
      `  Branch: ${handoff.branch}${handoff.commit ? ` at ${handoff.commit.slice(0, 12)}` : ""}`,
    );
  }
  io.write(
    `  Open review items: ${handoff.open_items.length}, now routed to ${handoff.to}. Cost so far: $${handoff.cost_usd.toFixed(2)}`,
  );
  io.write(`  ${TRANSCRIPT_LINES[outcome](vendor)}`);
  for (const warning of warnings) io.write(`  Warning: ${warning}`);
  io.write(`  Run: ${handoff.run_url}`);
  io.write(`${handoff.to} takes it over with: selfhost takeover ${short(handoff.id)}`);
  return report;
}

const TRANSCRIPT_LINES: Record<TranscriptOutcome, (vendor: string | undefined) => string> = {
  sent: () =>
    "Transcript: sent for a native resume, with secrets, emails and the team's [[redaction]] patterns masked first; the server deletes its copy at takeover.",
  team_off: () =>
    "Transcript: not sent, the team's [handoff] share_transcript is off (transcripts can hold secrets). The brief is the handoff.",
  declined: () => "Transcript: not sent (--no-transcript). The brief is the handoff.",
  unsupported_agent: (vendor) =>
    `Transcript: ${vendor ?? "this agent"} has no resume selfhost can carry; Claude Code and Codex do. The brief is the handoff.`,
  not_found: () =>
    "Transcript: not on this machine (the session ran elsewhere, or its log was cleaned up). The brief is the handoff.",
  too_large: () =>
    `Transcript: over ${HANDOFF_TRANSCRIPT_MAX_BYTES / 1024 / 1024} MB, so not sent. The brief is the handoff.`,
};

/** The full handoff id for what was typed: a full id, or the start of a pending one's. */
async function resolveHandoff(client: TeamClient, arg: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) return arg;
  const { handoffs } = await client.handoffs({ to: "me", state: "pending" });
  const matches = handoffs.filter((h) => h.id.startsWith(arg.toLowerCase()));
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length === 0) {
    throw new Error(
      `No pending handoff to you starts with ${arg}. selfhost inbox lists the ones handed to you.`,
    );
  }
  throw new Error(`${matches.length} pending handoffs start with ${arg}; type more of the id.`);
}

const quote = (text: string) => `"${text.replace(/(["\\$`])/g, "\\$1")}"`;

/** How the new owner carries on, from what the takeover could set up. */
function resumePlan(
  handoff: Handoff,
  placed: { path: string; resumeBy: "id" | "path" } | undefined,
  why: string | undefined,
): ResumePlan {
  const vendor = handoff.agent?.vendor;
  const prompt = `Read ${briefPath(handoff)} first: ${handoff.from} handed this run to you.`;
  if (placed && vendor === "claude_code") {
    const target = placed.resumeBy === "id" ? handoff.run_id : placed.path;
    return {
      command: `claude --resume ${target} ${quote(prompt)}`,
      native: true,
      why: "Claude Code resumes the session itself, with its history, under your own login.",
    };
  }
  if (placed && vendor === "codex") {
    return {
      command: `codex resume ${handoff.run_id} ${quote(prompt)}`,
      native: true,
      why: "Codex resumes the session itself, with its history, under your own login.",
    };
  }
  const program = vendor === "codex" ? "codex" : "claude";
  const fresh = `Read ${briefPath(handoff)} and carry on with the work it describes.`;
  return {
    command: `${program} ${quote(fresh)}`,
    native: false,
    why: `No native resume: ${why ?? "no transcript came with the handoff"}. Start a new session and point it at the brief.`,
  };
}

/** Why there is no transcript to resume from, for the brief. */
function noTranscriptWhy(handoff: Handoff): string {
  if (!isTranscriptAgent(handoff.agent?.vendor)) {
    return `${agentName(handoff)} has no resume selfhost can carry (Claude Code and Codex do)`;
  }
  return "the team does not share transcripts with handoffs ([handoff] share_transcript), or the previous owner's machine had none";
}

/**
 * `selfhost takeover <id>`: takes over a run handed to this person, under their own login. It
 * fetches and switches to the run's branch when the clone is clean, writes the handoff brief to
 * .selfhost/handoff/<id>.md (kept out of commits) and, when a transcript came with it, puts it
 * where the agent resumes it and prints the agent's own resume command.
 */
export async function runTakeover(
  arg: string,
  options: TakeoverOptions,
  io: HandoffIo,
): Promise<TakeoverReport> {
  refuseAgentSession("selfhost takeover", io.env);
  const { client, membership } = team(io, "Taking a run over");
  const git = io.git ?? systemGit;
  const id = await resolveHandoff(client, arg);
  const pending = await client.handoff(id);
  if (pending.to.toLowerCase() !== membership.person.toLowerCase()) {
    throw new Error(
      `This run was handed to ${pending.to}; only they can take it over. You are ${membership.person}.`,
    );
  }
  if (pending.state !== "pending") {
    throw new Error(
      pending.state === "taken"
        ? `Handoff ${short(id)} was taken over at ${pending.taken_at}.`
        : `Handoff ${short(id)} was superseded: the run was handed on again. selfhost inbox shows the newer one.`,
    );
  }
  let top: string | undefined;
  if (!options.print) {
    top = gitTop(git, options.repo ?? io.cwd);
    if (!top) {
      throw new Error(
        `Not in a git clone${pending.repo ? ` of ${pending.repo}` : ""}. Run it in one, pass --repo <dir>, or --print to read the brief without a clone.`,
      );
    }
    const origin = originRepo(git, top);
    if (pending.repo && origin?.toLowerCase() !== pending.repo.toLowerCase()) {
      throw new Error(
        `This clone is ${origin ?? "not on a known remote"}, and the run worked in ${pending.repo}. Run it in a clone of ${pending.repo}, pass --repo <dir>, or --print.`,
      );
    }
  }

  const taken = await client.takeover(id);
  const handoff = taken.handoff;
  const warnings: string[] = [];
  let checkout: CheckoutResult | null = null;
  let brief: string | null = null;
  let transcriptPath: string | null = null;
  let placed: { path: string; resumeBy: "id" | "path" } | undefined;
  if (top) {
    if (handoff.branch) {
      checkout = checkoutBranch(git, top, handoff.branch);
      if (!checkout.fetched) warnings.push(`${checkout.error}: fetch ${handoff.branch} yourself.`);
      else if (!checkout.switched)
        warnings.push(`Not switched to ${handoff.branch}: ${checkout.why}.`);
    } else {
      warnings.push("The handoff names no branch: ask the previous owner where the work is.");
    }
    const vendor = taken.transcript?.vendor;
    if (taken.transcript && isTranscriptAgent(vendor)) {
      const result = placeTranscript(
        vendor,
        {
          sessionId: handoff.run_id,
          fileName: taken.transcript.file_name,
          text: taken.transcript.text,
        },
        top,
        { env: io.env, home: io.home ?? homedir() },
        {
          spare: join(io.home ?? homedir(), ".selfhost", "handoffs", handoff.id),
          now: io.now ?? new Date(),
        },
      );
      placed = result;
      transcriptPath = result.path;
      if (!result.written) {
        warnings.push(`A transcript of this session was already at ${result.path}; it was kept.`);
      }
    }
  } else if (taken.transcript) {
    warnings.push(
      "--print: the transcript was not saved, and the server no longer keeps it. Resume from the brief.",
    );
  }
  const resume = resumePlan(
    handoff,
    placed,
    placed
      ? undefined
      : taken.transcript
        ? "the transcript was not saved"
        : noTranscriptWhy(handoff),
  );
  const text = renderBrief(handoff, resume);
  if (top) {
    const dir = join(top, BRIEF_DIR);
    mkdirSync(dir, { recursive: true });
    brief = join(top, briefPath(handoff));
    writeFileSync(brief, text);
    excludeLocally(git, top, `/${BRIEF_DIR}/`);
  }
  const report: TakeoverReport = {
    schema: "selfhost.takeover_result/v1",
    handoff,
    repo_dir: top ?? null,
    checkout,
    brief_path: brief,
    transcript_path: transcriptPath,
    resume,
    warnings,
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  if (options.print) {
    io.write(text.trimEnd());
    for (const warning of warnings) io.write(`Warning: ${warning}`);
    return report;
  }
  io.write(
    `You hold ${agentName(handoff)} run ${short(handoff.run_id)} now (from ${handoff.from}).`,
  );
  if (checkout?.fetched && checkout.switched) io.write(`  On branch ${handoff.branch}, fetched.`);
  io.write(`  Brief: ${briefPath(handoff)} (kept out of commits)`);
  if (transcriptPath) io.write(`  Transcript: ${transcriptPath}`);
  for (const warning of warnings) io.write(`  Warning: ${warning}`);
  io.write(resume.why);
  io.write(`  ${resume.command}`);
  return report;
}

export function registerHandoff(
  program: Command,
  io: () => HandoffIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("share")
    .description(
      "print a run's stable link to its timeline in the console, and post it on the run's pull requests through the GitHub App",
    )
    .argument("<session>", "the run: its agent session id")
    .option("--no-comment", "print the link only; post nothing on GitHub")
    .option("--json", "print JSON")
    .action(async (session: string, options: ShareOptions) => {
      try {
        await runShare(session, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  program
    .command("handoff")
    .description(
      "hand a run to a teammate: owner change in the ledger, with its branch, files, open review items, cost, last turns and a note (a person's decision: refused inside an agent session)",
    )
    .argument("<session>", "the run: its agent session id")
    .requiredOption("--to <person>", "the teammate who takes it over")
    .option("--note <text>", "what the new owner should know")
    .option("--turns <n>", `how many of the last turns to summarize (1 to ${HANDOFF_TURNS_MAX})`)
    .option("--no-transcript", "do not send the agent's transcript even when the team shares them")
    .option("--repo <dir>", "the clone the run worked in (default: the run's own, else here)")
    .option("--json", "print JSON")
    .action(async (session: string, options: HandoffOptions) => {
      try {
        await runHandoff(session, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  program
    .command("takeover")
    .description(
      "take over a run handed to you: fetch its branch, write the handoff brief and set up the agent's own resume where it has one (a person's decision: refused inside an agent session)",
    )
    .argument("<id>", "the handoff id, or its start (selfhost inbox lists them)")
    .option("--repo <dir>", "your clone of the run's repository (default: here)")
    .option("--print", "print the brief instead of writing it; change nothing in a clone")
    .option("--json", "print JSON")
    .action(async (id: string, options: TakeoverOptions) => {
      try {
        await runTakeover(id, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
