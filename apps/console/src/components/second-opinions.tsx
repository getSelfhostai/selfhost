import type { SecondOpinion } from "@selfhost/schema";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatTime } from "@/lib/format";
import { toolName } from "@/lib/labels";

const VERDICTS: Record<SecondOpinion["verdict"], { label: string; className: string }> = {
  approve: { label: "approved", className: "text-muted-foreground" },
  comment: {
    label: "commented",
    className: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  },
  changes: {
    label: "requested changes",
    className: "border-red-500/40 text-red-700 dark:text-red-300",
  },
  failed: { label: "failed to run", className: "border-dashed text-muted-foreground" },
};

/** "3 findings, highest critical", or nothing when the reviewer said neither. */
export function opinionCounts(opinion: Pick<SecondOpinion, "findings" | "severity">): string {
  const parts: string[] = [];
  if (opinion.findings !== undefined) {
    parts.push(`${opinion.findings} finding${opinion.findings === 1 ? "" : "s"}`);
  }
  if (opinion.severity) parts.push(`highest ${opinion.severity}`);
  return parts.join(", ");
}

/** One badge per reviewer, for the item's header line. */
export function SecondOpinionBadges({ opinions }: { opinions: readonly SecondOpinion[] }) {
  return opinions.map((opinion) => {
    const verdict = VERDICTS[opinion.verdict];
    return (
      <Badge key={opinion.tool} variant="outline" className={verdict.className}>
        {toolName(opinion.tool)}: {verdict.label}
      </Badge>
    );
  });
}

/**
 * What the team's AI reviewers said: the newest review from each, with its findings, the commit
 * it reviewed and a link to it on GitHub.
 */
export function SecondOpinions({
  opinions,
  headSha,
}: {
  opinions: readonly SecondOpinion[];
  /** The pull request's head, to mark a review of an earlier commit. */
  headSha?: string;
}) {
  if (opinions.length === 0) return null;
  return (
    <section aria-label="Second opinion" className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm">
      <p className="font-medium">Second opinion</p>
      <ul className="space-y-1">
        {opinions.map((opinion) => {
          const counts = opinionCounts(opinion);
          const earlier =
            opinion.head_sha && headSha && !headSha.startsWith(opinion.head_sha)
              ? `on earlier commit ${opinion.head_sha.slice(0, 7)}`
              : undefined;
          return (
            <li key={opinion.tool} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>
                {toolName(opinion.tool)} {VERDICTS[opinion.verdict].label}
                {counts ? `: ${counts}` : ""}
              </span>
              <span className="text-muted-foreground text-xs">
                {[formatTime(opinion.at), earlier].filter(Boolean).join(" · ")}
              </span>
              {opinion.url ? (
                <a
                  href={opinion.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:underline"
                >
                  Open the review
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
