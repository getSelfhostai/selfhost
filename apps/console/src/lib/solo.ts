import { getOptional } from "@/lib/api";
import { useConsole } from "@/lib/console-context";
import type { SoloResponse } from "@/lib/contracts";
import { useApi } from "@/lib/use-api";

/**
 * This laptop's own setup when the console runs in solo mode (the admin token of
 * `selfhost console`, no team yet): undefined while loading, null on a team server.
 */
export function useSolo(): SoloResponse | null | undefined {
  const { me, teams } = useConsole();
  const solo = me.kind === "admin" && teams.length === 0;
  const loaded = useApi(solo ? "solo" : null, (signal) =>
    getOptional<SoloResponse>("/v1/solo", signal),
  );
  if (!solo) return null;
  if (loaded.error) return null;
  return loaded.data;
}
