import type { ReceiptPreview } from "@selfhost/schema";

/** A GitHub deployment of the head commit, with its statuses newest first. */
export interface DeploymentInfo {
  environment: string;
  /** GitHub's production_environment flag. */
  production?: boolean;
  /** Login that created it, such as vercel[bot]. */
  creator?: string;
  created_at: string;
  statuses: { state: string; environment_url?: string; target_url?: string }[];
}

/** A commit status on the head commit, such as Netlify's deploy-preview. */
export interface CommitStatusInfo {
  context: string;
  state: string;
  target_url?: string;
}

const PENDING = new Set(["pending", "queued", "in_progress", "waiting"]);
const FAILED = new Set(["failure", "error"]);
const PRODUCTION = /^(?:prod|production|live)(?:\b|[-_ ])/i;
/** Netlify's commit status for a deploy preview: netlify/<site>/deploy-preview. */
const PREVIEW_STATUS = /deploy[-_ ]?preview/i;

const PROVIDERS: [RegExp, string][] = [
  [/(?:^|\.)vercel\.app$|vercel/i, "vercel"],
  [/(?:^|\.)netlify\.app$|netlify/i, "netlify"],
  [/(?:^|\.)pages\.dev$|cloudflare/i, "cloudflare"],
  [/(?:^|\.)onrender\.com$|render/i, "render"],
  [/(?:^|\.)fly\.dev$/i, "fly"],
];

function provider(...hints: (string | undefined)[]): string | undefined {
  for (const hint of hints) {
    if (!hint) continue;
    const host = URL.canParse(hint) ? new URL(hint).hostname : hint;
    const found = PROVIDERS.find(([pattern]) => pattern.test(host));
    if (found) return found[1];
  }
  return undefined;
}

const webUrl = (value: string | undefined) =>
  value && /^https?:\/\//i.test(value) && URL.canParse(value) ? value : undefined;

/**
 * The pull request's preview environment, from what the hosts report on its head commit:
 * GitHub deployments that are not production (Vercel, Netlify, Render, Cloudflare and others
 * create these), newest first, then deploy-preview commit statuses (Netlify). A ready one with
 * a URL wins; else one still deploying is pending; else a failed one is failed.
 */
export function findPreview(
  deployments: DeploymentInfo[],
  statuses: CommitStatusInfo[],
): ReceiptPreview {
  const candidates: ReceiptPreview[] = [];
  const sorted = deployments
    .filter((d) => d.production !== true && !PRODUCTION.test(d.environment))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const deployment of sorted) {
    const latest = deployment.statuses[0];
    const name = deployment.environment;
    const state = latest?.state ?? "pending";
    const url = webUrl(latest?.environment_url) ?? webUrl(latest?.target_url);
    const host = provider(deployment.creator, url, name);
    const common = {
      name,
      source: "deployment" as const,
      ...(host ? { provider: host } : {}),
    };
    if (state === "success" && url) candidates.push({ status: "ready", url, ...common });
    else if (PENDING.has(state)) candidates.push({ status: "pending", ...common });
    else if (FAILED.has(state)) candidates.push({ status: "failed", ...common });
  }
  for (const status of statuses) {
    if (!PREVIEW_STATUS.test(status.context)) continue;
    const url = webUrl(status.target_url);
    const host = provider(status.context, url);
    const common = {
      name: status.context,
      source: "commit_status" as const,
      ...(host ? { provider: host } : {}),
    };
    if (status.state === "success" && url) candidates.push({ status: "ready", url, ...common });
    else if (status.state === "pending") candidates.push({ status: "pending", ...common });
    else if (FAILED.has(status.state)) candidates.push({ status: "failed", ...common });
  }
  for (const wanted of ["ready", "pending", "failed"] as const) {
    const found = candidates.find((c) => c.status === wanted);
    if (found) return found;
  }
  return { status: "none" };
}

/** A preview link given by hand, such as an action input. */
export function givenPreview(url: string): ReceiptPreview {
  const host = provider(url);
  return { status: "ready", url, source: "input", ...(host ? { provider: host } : {}) };
}
