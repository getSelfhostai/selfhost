import type { ContextKind, ContextReader, Env } from "@selfhost/agents";
import type { SessionStats } from "../sessions.js";
import { CONTEXT_PRICING, type CountTokens, fileCost, o200kCounter, TOKENIZER } from "./cost.js";
import {
  type ContextConflict,
  type ContextDuplicate,
  findDrift,
  inReaderOrder,
  type SingleAgentRule,
} from "./drift.js";
import { type ContextDoc, type LoadMode, readContext } from "./files.js";

export type { ContextConflict, ContextDuplicate, SingleAgentRule } from "./drift.js";
export type { ContextDoc, LoadMode, McpServer } from "./files.js";

/** Agents whose sessions selfhost reads from local logs; the others are not priced. */
export const LOGGED_AGENTS: readonly ContextReader[] = ["claude_code", "codex"];

export interface ContextFileRow {
  /** Relative to the repository for repository files, ~/... for home files. */
  path: string;
  scope: "repo" | "home";
  kind: ContextKind;
  /** Agents that read the file with default settings. */
  readers: ContextReader[];
  load: LoadMode;
  bytes: number;
  /** The whole file. */
  tokens: number;
  /** What each session loads: the whole file, its name and description, or nothing. */
  always_tokens: number;
  /** MCP configs: server names. Their tool lists load every session but need the servers
   * running to count, so they are not priced. */
  mcp_servers: string[] | null;
  sessions_per_week: number;
  tokens_per_week: number;
  usd_per_week: number;
}

export interface ContextSection {
  /** The repository searched, or null when only the home config was. */
  repo: string | null;
  files: ContextFileRow[];
  totals: {
    files: number;
    /** Files that put tokens in every session. */
    always_loaded: number;
    tokens_per_week: number;
    usd_per_week: number;
  };
  duplicates: ContextDuplicate[];
  conflicts: ContextConflict[];
  single_agent: SingleAgentRule[];
  agents_in_use: ContextReader[];
  /** Agents that load some of these files but keep no logs selfhost reads. */
  unpriced_agents: ContextReader[];
  tokenizer: string;
  pricing: string;
}

/** The context files as read from disk, with token counts; the text never leaves memory. */
export interface ScannedContext {
  repo?: string;
  docs: { doc: ContextDoc; tokens: number; always: number }[];
}

export interface ScanContextOptions {
  home: string;
  env: Env;
  platform?: NodeJS.Platform;
  /** The repository to search; only the home config without it. */
  repo?: string;
  count?: CountTokens;
}

/** Finds and reads every context file and counts its tokens. */
export async function scanContext(options: ScanContextOptions): Promise<ScannedContext> {
  const docs = readContext({
    home: options.home,
    env: options.env,
    platform: options.platform,
    cwd: options.repo,
  });
  const count = docs.length > 0 ? (options.count ?? (await o200kCounter())) : () => 0;
  return {
    ...(options.repo ? { repo: options.repo } : {}),
    docs: docs.map((doc) => ({
      doc,
      tokens: count(doc.body),
      always: count(doc.alwaysText),
    })),
  };
}

export const emptyContext = (): ContextSection => ({
  repo: null,
  files: [],
  totals: { files: 0, always_loaded: 0, tokens_per_week: 0, usd_per_week: 0 },
  duplicates: [],
  conflicts: [],
  single_agent: [],
  agents_in_use: [],
  unpriced_agents: [],
  tokenizer: TOKENIZER,
  pricing: CONTEXT_PRICING,
});

/**
 * The context section of the scan: every file with who reads it and what it costs a week,
 * duplicates, conflicts and rules only one agent sees. Pure: the same input gives the same
 * section.
 */
export function contextSection(
  scanned: ScannedContext | undefined,
  sessions: SessionStats[],
  window: { from: Date; to: Date },
): ContextSection {
  if (!scanned) return emptyContext();
  const files = scanned.docs.map(({ doc, tokens, always }): ContextFileRow => {
    const cost = fileCost(doc, always, sessions, window, scanned.repo);
    return {
      path: doc.display,
      scope: doc.file.scope,
      kind: doc.file.kind,
      readers: doc.file.readers,
      load: doc.load,
      bytes: doc.file.size,
      tokens,
      always_tokens: always,
      mcp_servers: doc.file.kind === "mcp" ? doc.servers.map((server) => server.name) : null,
      sessions_per_week: cost.sessions_per_week,
      tokens_per_week: cost.tokens_per_week,
      usd_per_week: cost.usd_per_week,
    };
  });
  const sessionAgents = LOGGED_AGENTS.filter((agent) =>
    sessions.some((session) => session.vendor === agent),
  );
  const drift = findDrift(
    scanned.docs.map(({ doc }) => doc),
    sessionAgents,
  );
  const loaded = files.filter((file) => file.always_tokens > 0 || file.mcp_servers !== null);
  return {
    repo: scanned.repo ?? null,
    files,
    totals: {
      files: files.length,
      always_loaded: files.filter((file) => file.always_tokens > 0).length,
      tokens_per_week: files.reduce((total, file) => total + file.tokens_per_week, 0),
      usd_per_week: files.reduce((total, file) => total + file.usd_per_week, 0),
    },
    duplicates: drift.duplicates,
    conflicts: drift.conflicts,
    single_agent: drift.single_agent,
    agents_in_use: drift.agents_in_use,
    unpriced_agents: inReaderOrder(loaded.flatMap((file) => file.readers)).filter(
      (reader) => !LOGGED_AGENTS.includes(reader),
    ),
    tokenizer: TOKENIZER,
    pricing: CONTEXT_PRICING,
  };
}
