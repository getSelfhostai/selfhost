import type { UsageRow, UsageTotals } from "@selfhost/schema";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DIMENSION_NAMES,
  formatCacheHits,
  formatCompact,
  formatCount,
  formatUsd,
  label,
} from "@/lib/format";
import type { Breakdown } from "@/lib/view";

export interface BreakdownTableProps {
  breakdown: Breakdown;
  rows: UsageRow[];
  total: UsageTotals;
  /** Filters the console to one value; undefined when that filter is already set. */
  onPick?: (value: string) => void;
}

const numeric = "text-right tabular-nums";

export function BreakdownTable({ breakdown, rows, total, onPick }: BreakdownTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{DIMENSION_NAMES[breakdown].one}</TableHead>
          <TableHead className={numeric}>Cost</TableHead>
          <TableHead className="w-32">
            <span className="sr-only">Share of cost</span>
          </TableHead>
          <TableHead className={numeric}>Tokens</TableHead>
          <TableHead className={numeric} title="Input tokens read from the prompt cache">
            Cache hits
          </TableHead>
          <TableHead className={numeric}>Requests</TableHead>
          <TableHead className={numeric}>Sessions</TableHead>
          <TableHead className={numeric}>PRs opened</TableHead>
          <TableHead className={numeric}>PRs merged</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const value = row.group[breakdown] ?? "unknown";
          const share = total.usd > 0 ? row.usd / total.usd : 0;
          return (
            <TableRow key={value}>
              <TableCell className="max-w-64 truncate font-medium">
                {onPick ? (
                  <button
                    type="button"
                    className="truncate text-left underline-offset-4 hover:underline"
                    title={`Only ${value}`}
                    onClick={() => onPick(value)}
                  >
                    {label(breakdown, value)}
                  </button>
                ) : (
                  label(breakdown, value)
                )}
              </TableCell>
              <TableCell className={numeric}>{formatUsd(row.usd)}</TableCell>
              <TableCell>
                <div
                  className="h-1.5 rounded-full bg-muted"
                  role="img"
                  aria-label={`${Math.round(share * 100)}% of cost`}
                >
                  <div
                    className="h-1.5 rounded-full bg-chart-1"
                    style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }}
                  />
                </div>
              </TableCell>
              <TableCell className={numeric} title={formatCount(row.tokens)}>
                {formatCompact(row.tokens)}
              </TableCell>
              <TableCell className={numeric}>{formatCacheHits(row.cache_hit_rate)}</TableCell>
              <TableCell className={numeric}>{formatCount(row.requests)}</TableCell>
              <TableCell className={numeric}>{formatCount(row.sessions)}</TableCell>
              <TableCell className={numeric}>{formatCount(row.prs_opened)}</TableCell>
              <TableCell className={numeric}>{formatCount(row.prs_merged)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell className={numeric}>{formatUsd(total.usd)}</TableCell>
          <TableCell />
          <TableCell className={numeric} title={formatCount(total.tokens)}>
            {formatCompact(total.tokens)}
          </TableCell>
          <TableCell className={numeric}>{formatCacheHits(total.cache_hit_rate)}</TableCell>
          <TableCell className={numeric}>{formatCount(total.requests)}</TableCell>
          <TableCell className={numeric}>{formatCount(total.sessions)}</TableCell>
          <TableCell className={numeric}>{formatCount(total.prs_opened)}</TableCell>
          <TableCell className={numeric}>{formatCount(total.prs_merged)}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}
