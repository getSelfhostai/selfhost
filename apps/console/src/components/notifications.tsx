import type { NotifyCadence, NotifySettings, NotifyTestResponse } from "@selfhost/schema";
import { Send, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Failed, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getOptional, send } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";

const CADENCES: { value: NotifyCadence; label: string }[] = [
  { value: "daily", label: "Daily digest" },
  { value: "weekly", label: "Weekly digest" },
  { value: "off", label: "No digest" },
];

const DELIVERY: Record<NotifySettings["delivery"], string | undefined> = {
  apprise_api: undefined,
  apprise_cli: undefined,
  none: "This server has no Apprise yet, so nothing is sent. Its operator adds compose.notify.yml or sets SELFHOST_APPRISE_URL.",
};

/**
 * The signed-in person's own notifications: their targets (Apprise URLs, shown masked), their
 * digest cadence and a test send. Agents that wait on them are pushed at once; the rest comes in
 * the digest; approving happens here in the console, through the link in each message.
 */
export function Notifications() {
  const loaded = useApi("notify", (signal) => getOptional<NotifySettings>("/v1/notify", signal));
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState<{ text: string; failed?: boolean }>();

  const act = async (work: () => Promise<string | undefined>) => {
    try {
      const text = await work();
      setNote(text ? { text } : undefined);
      loaded.reload();
    } catch (error) {
      setNote({ text: (error as Error).message, failed: true });
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await send("POST", "/v1/notify/targets", {
        url: url.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setUrl("");
      setName("");
      return "Target added. Send a test to check it.";
    });
  };

  const test = () =>
    act(async () => {
      const { sends } = await send<NotifyTestResponse>("POST", "/v1/notify/test", {});
      return sends
        .map((s) =>
          s.ok ? `${s.target}: sent` : `${s.target}: failed (${s.error ?? "no reason"})`,
        )
        .join(". ");
    });

  if (loaded.data === null) return null;
  const settings = loaded.data;
  return (
    <Section
      title="Your notifications"
      description="Phone, chat and email through Apprise: agents that wait on you right away, everything else in your digest."
    >
      {loaded.error ? <Failed error={loaded.error} what="your notifications" /> : null}
      {settings && DELIVERY[settings.delivery] ? (
        <p className="text-muted-foreground text-sm">{DELIVERY[settings.delivery]}</p>
      ) : null}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-80"
          type="password"
          autoComplete="off"
          placeholder="tgram://bot-token/chat-id, slack://..., mailtos://..."
          aria-label="Apprise URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Input
          className="w-full sm:w-36"
          placeholder="Name (optional)"
          aria-label="Target name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!url.trim()}>
          Add target
        </Button>
      </form>
      {note ? (
        <p
          role="status"
          className={note.failed ? "text-destructive text-sm" : "text-muted-foreground text-sm"}
        >
          {note.text}
        </p>
      ) : null}
      {settings && settings.targets.length > 0 ? (
        <ul className="divide-y rounded-xl border">
          {settings.targets.map((target) => (
            <li
              key={target.name}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"
              data-testid="notify-target"
            >
              <span className="min-w-0 truncate">
                {target.name}
                <span className="text-muted-foreground">
                  {" "}
                  · {target.masked} · added {formatTime(target.created_at)}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  act(async () => {
                    await send("DELETE", `/v1/notify/targets/${encodeURIComponent(target.name)}`);
                    return `${target.name} removed.`;
                  })
                }
              >
                <Trash2 />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {settings ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={settings.digest}
            onValueChange={(digest) =>
              act(async () => {
                await send("PUT", "/v1/notify/digest", { digest });
                return undefined;
              })
            }
          >
            <SelectTrigger size="sm" className="w-40" aria-label="Digest">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CADENCES.map((cadence) => (
                <SelectItem key={cadence.value} value={cadence.value}>
                  {cadence.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {settings.targets.length > 0 && settings.delivery !== "none" ? (
            <Button size="sm" variant="outline" onClick={test}>
              <Send />
              Send a test
            </Button>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
