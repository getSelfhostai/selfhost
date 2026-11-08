import type { UsageRow } from "@selfhost/schema";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompact, formatCount, formatDay, formatUsd, label } from "@/lib/format";
import type { Breakdown, ChartMetric } from "@/lib/view";

/** Series beyond these are added up as Other, so the chart stays readable. */
const MAX_SERIES = 5;
// Ids sort as Recharts lists them in the legend: the series in order, then Other.
const OTHER = "other";
const COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

export interface UsageChartProps {
  /** Rows grouped by day and the breakdown. */
  rows: UsageRow[];
  days: string[];
  breakdown: Breakdown;
  metric: ChartMetric;
  /** The breakdown's values, highest spend first, from the table. */
  order: string[];
}

const formatValue = (metric: ChartMetric, value: number) =>
  metric === "usd" ? formatUsd(value) : formatCount(value);

export function UsageChart({ rows, days, breakdown, metric, order }: UsageChartProps) {
  // Values with none of this metric (a model with only pull requests) get no series.
  const amount = new Map<string, number>();
  for (const row of rows) {
    const value = row.group[breakdown];
    if (value !== undefined) amount.set(value, (amount.get(value) ?? 0) + row[metric]);
  }
  const shown = order.filter((value) => (amount.get(value) ?? 0) > 0);
  const top = shown.slice(0, MAX_SERIES);
  const hasOther = shown.length > MAX_SERIES;
  const seriesId = (value: string) => {
    const at = top.indexOf(value);
    return at === -1 ? OTHER : `a${at}`;
  };
  const config: ChartConfig = Object.fromEntries(
    top.map((value, index) => [
      `a${index}`,
      { label: label(breakdown, value), color: `var(${COLORS[index]})` },
    ]),
  );
  if (hasOther) config[OTHER] = { label: "Other", color: "var(--chart-other)" };
  const byDay = new Map(days.map((day) => [day, { day } as Record<string, number | string>]));
  for (const row of rows) {
    const point = byDay.get(row.group.day ?? "");
    const value = row.group[breakdown];
    if (!point || value === undefined) continue;
    const id = seriesId(value);
    point[id] = Number(point[id] ?? 0) + row[metric];
  }
  const data = [...byDay.values()];

  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <BarChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(day: string) => formatDay(day)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(value: number) =>
            metric === "usd" ? `$${formatCompact(value)}` : formatCompact(value)
          }
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => formatDay(String(payload?.[0]?.payload?.day ?? ""))}
              valueFormatter={(value) => formatValue(metric, Number(value))}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-y-1" />} />
        {Object.keys(config).map((id) => (
          <Bar
            key={id}
            dataKey={id}
            stackId="usage"
            fill={`var(--color-${id})`}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
