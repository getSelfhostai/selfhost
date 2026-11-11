import { type HandoffsResponse, type MeResponse, shortIds } from "@selfhost/schema";
import { Section } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { getOptional } from "@/lib/api";
import { RunLink } from "@/lib/console-context";
import { ago } from "@/lib/format";
import { useApi } from "@/lib/use-api";

/**
 * Runs teammates handed to the signed-in person and not taken over yet. Taking one over happens
 * on their own machine (selfhost takeover), under their own agent login, so the console shows
 * the command rather than doing it. Servers without handoffs show nothing.
 */
export function HandedToYou({ me, now }: { me: MeResponse; now: Date }) {
  const person = me.kind === "person";
  const loaded = useApi(person ? "handoffs:mine" : null, (signal) =>
    getOptional<HandoffsResponse>("/v1/handoffs?to=me&state=pending", signal),
  );
  const handoffs = loaded.data?.handoffs ?? [];
  if (handoffs.length === 0) return null;
  const short = shortIds(handoffs.map((handoff) => handoff.id));
  return (
    <Section
      title="Handed to you"
      description="Take a run over in your clone of its repository; it then runs under your own login."
    >
      <div className="space-y-2">
        {handoffs.map((handoff) => (
          <Card key={handoff.id} className="py-3">
            <CardContent className="space-y-1 px-4 text-sm">
              <p>
                <RunLink id={handoff.run_id}>Run {handoff.run_id.slice(0, 8)}</RunLink> from{" "}
                {handoff.from}, {ago(handoff.created_at, now)}
                {handoff.repo ? `, ${handoff.repo}` : ""}
                {handoff.branch ? ` on ${handoff.branch}` : ""}
              </p>
              {handoff.note ? <p className="text-muted-foreground">{handoff.note}</p> : null}
              <p className="text-muted-foreground text-xs">
                {handoff.open_items.length} open review item
                {handoff.open_items.length === 1 ? "" : "s"}, ${handoff.cost_usd.toFixed(2)} so far.
                Take it over:{" "}
                <code className="font-mono">
                  selfhost takeover {short.get(handoff.id) ?? handoff.id}
                </code>
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </Section>
  );
}
