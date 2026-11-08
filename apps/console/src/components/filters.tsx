import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DIMENSION_NAMES, label } from "@/lib/format";
import { type Breakdown, PRESETS, type Preset, type View } from "@/lib/view";

const PRESET_NAMES: Record<Preset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
};

const ALL = "__all__";

export interface FilterBarProps {
  view: View;
  /** The values each filter offers, from the range without other filters. */
  options: Partial<Record<Breakdown, string[]>>;
  /** Filters to show: the team filter only when the caller sees more than one team. */
  dimensions: Breakdown[];
  days: { first: string; last: string };
  onChange: (view: View) => void;
  onExport: () => void;
  exporting: boolean;
}

export function FilterBar({
  view,
  options,
  dimensions,
  days,
  onChange,
  onExport,
  exporting,
}: FilterBarProps) {
  const filtered = Object.values(view.filters).some(Boolean);
  const setFilter = (name: Breakdown, value: string) => {
    const filters = { ...view.filters };
    if (value === ALL) delete filters[name];
    else filters[name] = value;
    onChange({ ...view, filters });
  };
  const setDay = (which: "from" | "to", value: string) => {
    if (!value) return;
    const from = which === "from" ? value : (view.from ?? days.first);
    const to = which === "to" ? value : (view.to ?? days.last);
    if (from > to) return;
    onChange({ ...view, range: "custom", from, to });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={view.range}
        onValueChange={(range) => {
          if (range === "custom") {
            onChange({ ...view, range: "custom", from: days.first, to: days.last });
          } else {
            const { from: _from, to: _to, ...rest } = view;
            onChange({ ...rest, range: range as Preset });
          }
        }}
      >
        <SelectTrigger className="w-40" aria-label="Date range">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((preset) => (
            <SelectItem key={preset} value={preset}>
              {PRESET_NAMES[preset]}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom range</SelectItem>
        </SelectContent>
      </Select>
      {view.range === "custom" ? (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            className="w-38"
            aria-label="From"
            value={view.from ?? days.first}
            max={view.to ?? days.last}
            onChange={(event) => setDay("from", event.target.value)}
          />
          <span className="text-muted-foreground text-sm">to</span>
          <Input
            type="date"
            className="w-38"
            aria-label="To"
            value={view.to ?? days.last}
            min={view.from ?? days.first}
            onChange={(event) => setDay("to", event.target.value)}
          />
        </div>
      ) : null}
      {dimensions.map((name) => {
        const values = options[name] ?? [];
        const current = view.filters[name];
        const listed = current && !values.includes(current) ? [current, ...values] : values;
        return (
          <Select key={name} value={current ?? ALL} onValueChange={(v) => setFilter(name, v)}>
            <SelectTrigger
              className="w-44 data-[active=true]:border-foreground/40"
              data-active={current !== undefined}
              aria-label={DIMENSION_NAMES[name].one}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All {DIMENSION_NAMES[name].many.toLowerCase()}</SelectItem>
              {listed.map((value) => (
                <SelectItem key={value} value={value}>
                  {label(name, value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      })}
      {filtered ? (
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...view, filters: {} })}>
          <X />
          Clear filters
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="ml-auto"
        onClick={onExport}
        disabled={exporting}
      >
        <Download />
        Export CSV
      </Button>
    </div>
  );
}
