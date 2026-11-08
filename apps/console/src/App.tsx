import type { MeResponse } from "@selfhost/schema";
import { useCallback, useEffect, useState } from "react";
import { Console } from "@/components/console";
import { SignIn } from "@/components/sign-in";
import { ApiRequestError, forgetToken, getMe, saveToken, storedToken } from "@/lib/api";
import { parseView, type View, viewSearch } from "@/lib/view";

type Session =
  | { state: "loading" }
  | { state: "signed_in"; me: MeResponse; withToken: boolean }
  | { state: "signed_out"; error?: string };

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [view, setView] = useState<View>(() => parseView(window.location.search));

  const check = useCallback(async (rejected?: string): Promise<void> => {
    try {
      const me = await getMe();
      setSession({ state: "signed_in", me, withToken: storedToken() !== undefined });
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        // A stored token the server no longer takes is dropped; sign-in at a proxy may still work.
        if (storedToken() !== undefined) {
          forgetToken();
          return check("That token is not valid on this server.");
        }
        setSession({ state: "signed_out", ...(rejected ? { error: rejected } : {}) });
      } else {
        setSession({ state: "signed_out", error: `Could not reach the server: ${String(error)}` });
      }
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    const onPop = () => setView(parseView(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const change = (next: View) => {
    const moved = next.screen !== view.screen || next.run !== view.run;
    window.history.pushState(null, "", `${window.location.pathname}${viewSearch(next)}`);
    setView(next);
    if (moved) window.scrollTo({ top: 0 });
  };

  if (session.state === "loading") return null;
  if (session.state === "signed_out") {
    return (
      <SignIn
        {...(session.error ? { error: session.error } : {})}
        onToken={(token) => {
          saveToken(token);
          void check();
        }}
      />
    );
  }
  return (
    <Console
      me={session.me}
      view={view}
      onChange={change}
      {...(session.withToken
        ? {
            onSignOut: () => {
              forgetToken();
              setSession({ state: "signed_out" });
            },
          }
        : {})}
    />
  );
}
