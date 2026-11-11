import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function SignIn({
  error,
  link = false,
  onToken,
}: {
  error?: string;
  /** Opened from a link to a run or a screen, such as one a teammate shared. */
  link?: boolean;
  onToken: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) onToken(token.trim());
  };
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to selfhost</CardTitle>
          <CardDescription>
            {link
              ? "This link opens a page of a selfhost server, for the people in its team. Sign in to see it."
              : "Paste an API token. It stays in this browser and is sent only to this server."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="selfhost_..."
              aria-label="API token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={!token.trim()}>
              Sign in
            </Button>
          </form>
          <ul className="mt-6 space-y-2 text-muted-foreground text-sm">
            {link ? (
              <li>
                Not in the team yet? Ask a team owner or admin for an invite (
                <code className="text-foreground">selfhost team invite</code>), join with{" "}
                <code className="text-foreground">selfhost join &lt;server&gt; &lt;invite&gt;</code>
                , then run <code className="text-foreground">selfhost console</code>: it signs this
                browser in, and the link opens.
              </li>
            ) : null}
            <li>
              On your laptop, run <code className="text-foreground">selfhost console</code>: it
              opens this page signed in.
            </li>
            <li>
              On a team server, run <code className="text-foreground">selfhost console</code> on a
              laptop that joined the team (with{" "}
              <code className="text-foreground">selfhost join &lt;server&gt; &lt;invite&gt;</code>
              ): it opens this page signed in as you. Or paste the server's admin token.
            </li>
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
