import picomatch from "picomatch/posix.js";
import type { ChangedFile } from "./select.js";

/** A screen to take a screenshot of, and the changed files that map to it. */
export interface PlannedShot {
  /** URL path, such as /settings. */
  path: string;
  files: string[];
}

export interface ScreenPlan {
  shots: PlannedShot[];
  notes: string[];
}

/**
 * The screens to capture: the URL paths [receipt.screens] maps the changed files to, in the
 * order the map lists them, each once with every file that led to it. Without a map, the home
 * page. At most `max`; the rest are named in a note.
 */
export function mapScreens(
  changed: ChangedFile[],
  screens: Record<string, string[]> | undefined,
  max: number,
): ScreenPlan {
  if (!screens) {
    return {
      shots: [{ path: "/", files: [] }],
      notes: ["selfhost.toml has no [receipt.screens], so the receipt captured the home page."],
    };
  }
  const byPath = new Map<string, PlannedShot>();
  for (const [glob, paths] of Object.entries(screens)) {
    const matches = picomatch(glob, { dot: true });
    const files = changed
      .flatMap((file) => (file.previousPath ? [file.path, file.previousPath] : [file.path]))
      .filter((path) => matches(path));
    if (files.length === 0) continue;
    for (const raw of paths) {
      const path = raw.startsWith("/") ? raw : `/${raw}`;
      const shot = byPath.get(path) ?? { path, files: [] };
      for (const file of files) if (!shot.files.includes(file)) shot.files.push(file);
      byPath.set(path, shot);
    }
  }
  const all = [...byPath.values()];
  const notes: string[] = [];
  if (all.length === 0) {
    notes.push("No changed file matches [receipt.screens], so no screens were captured.");
  }
  if (all.length > max) {
    notes.push(
      `${all.length - max} more mapped screens were not captured, over [receipt] max_screens (${max}).`,
    );
  }
  return { shots: all.slice(0, max), notes };
}

/** The screenshot's path in the artifact, unique among `taken`: /settings/billing is screens/settings-billing.png. */
export function shotFile(path: string, taken: Set<string>): string {
  const slug =
    path
      .replace(/[?#].*$/, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "home";
  let name = `screens/${slug}.png`;
  for (let n = 2; taken.has(name); n += 1) name = `screens/${slug}-${n}.png`;
  taken.add(name);
  return name;
}

/** The screen's URL under `base`, keeping the base's own path: base /app and /settings give /app/settings. */
export function screenUrl(base: string, path: string): string {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, "");
  const cut = path.search(/[?#]/);
  const pathname = cut < 0 ? path : path.slice(0, cut);
  url.pathname = `${prefix}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  url.search = "";
  url.hash = "";
  return `${url.toString()}${cut < 0 ? "" : path.slice(cut)}`;
}
