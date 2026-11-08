import type { MeResponse } from "@selfhost/schema";
import {
  type AnchorHTMLAttributes,
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
} from "react";
import { type Screen, type View, viewSearch } from "@/lib/view";

export interface ConsoleState {
  me: MeResponse;
  view: View;
  /** The clock screens measure "this week" and ages against. */
  now: Date;
  /** The team every team screen is about: the one picked, else the caller's own, else the first. */
  team: string | undefined;
  /** Teams the caller can pick from. */
  teams: string[];
  go: (view: View) => void;
}

const Context = createContext<ConsoleState | null>(null);

export const ConsoleProvider = Context.Provider;

export function useConsole(): ConsoleState {
  const state = useContext(Context);
  if (!state) throw new Error("useConsole outside the console");
  return state;
}

/** The view for a screen, keeping the team, org and range. */
export function screenView(view: View, screen: Screen, run?: string): View {
  const { screen: _screen, run: _run, ...rest } = view;
  return {
    ...rest,
    ...(screen === "overview" ? {} : { screen }),
    ...(run ? { run } : {}),
  };
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: View };

/** A real link to another view that the console opens in place. */
export function ViewLink({ to, onClick, ...props }: LinkProps) {
  const { go } = useConsole();
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.button !== 0) return;
    event.preventDefault();
    go(to);
  };
  return <a href={viewSearch(to) || "?"} onClick={open} {...props} />;
}

/** A link to one run's view. */
export function RunLink({
  id,
  children,
  className,
}: {
  id: string;
  children?: ReactNode;
  className?: string;
}) {
  const { view } = useConsole();
  return (
    <ViewLink
      to={screenView(view, "run", id)}
      className={className ?? "underline-offset-4 hover:underline"}
    >
      {children ?? id}
    </ViewLink>
  );
}
