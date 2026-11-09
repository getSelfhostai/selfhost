import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CompileResult, PLATFORMS, type Platform } from "@selfhost/compile";
import type { CompileVendor, LaptopManaged, ManagedState } from "@selfhost/schema";
import { plural } from "../format.js";

/**
 * Installing the compiled managed settings at the system paths each vendor reads: Claude Code's
 * managed-settings.d drop-in, Codex's requirements.toml and hook script, Cursor's enterprise
 * hooks.json and Copilot's managed-settings.json. selfhost writes a file only where the user
 * running it may write, and prints the admin command for the rest. It never runs sudo or asks
 * for elevation itself.
 */

/** One file the policy compiles to, with the system path its vendor reads on a platform. */
export interface ManagedFile {
  vendor: CompileVendor;
  /** Path inside the vendor's folder of the compile output. */
  name: string;
  content: string;
  mode: "0644" | "0755";
  /** The path the vendor reads, as written for that platform. */
  target: string;
}

export const MANAGED_FILE_STATUSES = [
  "current",
  "written",
  "needs_admin",
  "conflict",
  "skipped",
  "failed",
] as const;

/**
 * current: already what the policy compiles to. written: written by this run. needs_admin: the
 * user may not write there. conflict: a file selfhost did not write is there, left alone.
 * skipped: the install is turned off. failed: another error, in message.
 */
export type ManagedFileStatus = (typeof MANAGED_FILE_STATUSES)[number];

export interface ManagedFileReport {
  vendor: CompileVendor;
  /** The path the vendor reads. */
  target: string;
  /** Where it is on this machine: the target, or under --root. */
  path: string;
  status: ManagedFileStatus;
  message?: string;
}

export interface ManagedReport {
  state: ManagedState;
  /** null on platforms selfhost knows no paths for. */
  platform: Platform | null;
  files: ManagedFileReport[];
  /** Admin commands that install the files still pending. selfhost prints them, never runs them. */
  commands: string[];
}

export interface ManagedInstallOptions {
  platform: string;
  /** Write under this folder instead of the real system paths: for images and tests. */
  root?: string;
  /** Where copies go for the admin commands to read. Default: next to each file's source. */
  staging: string;
  /** Records the hashes of files selfhost wrote or staged, to tell its own files from others. */
  known: string;
  /** false: only report where each file stands. */
  write: boolean;
  /** Replace files selfhost did not write. */
  force?: boolean;
  /** Existing copies of the files, used as the command source instead of staging new ones. */
  sources?: Map<ManagedFile, string>;
}

const isPlatform = (platform: string): platform is Platform =>
  (PLATFORMS as readonly string[]).includes(platform);

/**
 * The files of a compile that go to system paths on a platform. Per-user files (device
 * management delivers them to each home folder) and dashboard text are not among them.
 */
export function managedFiles(result: CompileResult, platform: string): ManagedFile[] {
  if (!isPlatform(platform)) return [];
  return result.vendors.flatMap((vendor) =>
    vendor.files.flatMap((file): ManagedFile[] => {
      if (file.install.kind !== "system") return [];
      const target = file.install.paths[platform];
      if (target === undefined) return [];
      return [
        {
          vendor: vendor.vendor,
          name: file.name,
          content: file.content,
          mode: file.install.mode,
          target,
        },
      ];
    }),
  );
}

/**
 * A system path on this machine: the path itself, or with root, the same path under that
 * folder, a Windows drive becoming a folder (C:\Program Files becomes <root>/C/Program Files).
 */
export function systemPath(target: string, root: string | undefined): string {
  if (root === undefined) return target;
  const drive = /^([A-Za-z]):[\\/]/.exec(target);
  const rest = drive ? target.slice(3) : target;
  return join(root, ...(drive ? [drive[1] ?? ""] : []), ...rest.split(/[\\/]+/).filter(Boolean));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The Codex requirements header, the one file of a fixed name selfhost marks as its own. */
const SELFHOST_MARK = "written by selfhost policy compile";

interface Known {
  schema: "selfhost.managed_known/v1";
  /** sha256 of each version of a file selfhost wrote or staged, newest last. */
  files: Record<string, string[]>;
}

const KEEP_HASHES = 10;

function readKnown(path: string): Known {
  try {
    const known = JSON.parse(readFileSync(path, "utf8")) as Known;
    if (known.schema === "selfhost.managed_known/v1" && known.files) return known;
  } catch {}
  return { schema: "selfhost.managed_known/v1", files: {} };
}

function remember(known: Known, path: string, hash: string): void {
  const hashes = (known.files[path] ?? []).filter((h) => h !== hash);
  known.files[path] = [...hashes, hash].slice(-KEEP_HASHES);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

/** Writes through a temporary file and a rename, so a vendor never reads half a file. */
function writeAtomic(path: string, content: string, mode: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.selfhost-${process.pid}`;
  try {
    writeFileSync(temp, content, { mode: Number.parseInt(mode, 8) });
    chmodSync(temp, Number.parseInt(mode, 8));
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** A path quoted for sh, or for PowerShell on Windows. */
function quote(path: string, platform: string): string {
  return platform === "win32"
    ? `'${path.replaceAll("'", "''")}'`
    : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The admin command that installs one file. selfhost prints it and never runs it. */
export function adminCommand(source: string, path: string, mode: string, platform: string): string {
  if (platform === "win32") {
    return `New-Item -ItemType Directory -Force -Path ${quote(dirname(path), platform)} | Out-Null; Copy-Item -Force ${quote(source, platform)} ${quote(path, platform)}`;
  }
  return `sudo mkdir -p ${quote(dirname(path), platform)} && sudo install -o root -m ${mode} ${quote(source, platform)} ${quote(path, platform)}`;
}

/**
 * Puts each file at its system path where this user may write, and reports the rest with the
 * admin command that installs it. A file already there is replaced only when selfhost wrote it
 * (its hash is recorded in `known`, or it carries selfhost's mark) or with `force`.
 */
export function installManaged(
  files: ManagedFile[],
  options: ManagedInstallOptions,
): ManagedReport {
  const platform = isPlatform(options.platform) ? options.platform : null;
  const known = readKnown(options.known);
  const reports: ManagedFileReport[] = [];
  const commands: string[] = [];
  let changed = false;
  for (const file of files) {
    const path = systemPath(file.target, options.root);
    const hash = sha256(file.content);
    const report: ManagedFileReport = {
      vendor: file.vendor,
      target: file.target,
      path,
      status: "current",
    };
    reports.push(report);
    let existing: string | undefined;
    try {
      existing = readText(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!DENIED.has(code)) {
        report.status = "failed";
        report.message = (error as Error).message;
        continue;
      }
      existing = undefined;
    }
    if (existing === file.content) continue;
    const ours =
      existing === undefined ||
      options.force === true ||
      known.files[path]?.includes(sha256(existing)) === true ||
      existing.includes(SELFHOST_MARK);
    if (!options.write) {
      report.status = "skipped";
      continue;
    }
    if (ours) {
      try {
        writeAtomic(path, file.content, file.mode);
        report.status = "written";
        remember(known, path, hash);
        changed = true;
        continue;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!DENIED.has(code)) {
          report.status = "failed";
          report.message = (error as Error).message;
          continue;
        }
        report.status = "needs_admin";
      }
    } else {
      report.status = "conflict";
      report.message =
        "A file selfhost did not write is there. Merge it by hand, or install this one over it with the command below.";
    }
    let source = options.sources?.get(file);
    if (source === undefined) {
      source = join(options.staging, file.vendor, file.name);
      try {
        writeAtomic(source, file.content, file.mode);
      } catch (error) {
        report.status = "failed";
        report.message = `Could not stage a copy at ${source}: ${(error as Error).message}`;
        continue;
      }
    }
    remember(known, path, hash);
    changed = true;
    commands.push(adminCommand(source, path, file.mode, options.platform));
  }
  if (changed) {
    try {
      mkdirSync(dirname(options.known), { recursive: true });
      writeFileSync(options.known, `${JSON.stringify(known, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Only the conflict check reads it; a later run writes it again.
    }
  }
  return { state: managedState(reports, options.write), platform, files: reports, commands };
}

function managedState(files: ManagedFileReport[], write: boolean): ManagedState {
  if (files.length === 0) return "none";
  if (files.every((file) => file.status === "current" || file.status === "written")) {
    return "current";
  }
  return write ? "pending" : "off";
}

/** The heartbeat's summary of a report. */
export function managedSummary(report: ManagedReport | undefined): LaptopManaged {
  if (!report) return { state: "none", files: 0, pending: 0 };
  const pending = report.files.filter(
    (file) => file.status !== "current" && file.status !== "written",
  ).length;
  return { state: report.state, files: report.files.length, pending };
}

/** Lines that say what an install did, with the admin commands for what is left. */
export function describeManaged(report: ManagedReport): string[] {
  const { files } = report;
  if (files.length === 0) return [];
  const count = (status: ManagedFileStatus) => files.filter((f) => f.status === status).length;
  const written = files.filter((file) => file.status === "written");
  const lines: string[] = [];
  if (written.length > 0) {
    lines.push(
      `Installed ${plural(written.length, "managed settings file")}: ${written.map((f) => f.path).join(", ")}.`,
    );
  }
  if (report.state === "current" && written.length === 0) {
    lines.push(`Managed settings: all ${plural(files.length, "file")} up to date.`);
  }
  if (report.state === "off") {
    lines.push(
      `Managed settings install is off here: ${count("skipped")} of ${plural(files.length, "file")} differ from the team policy.`,
    );
  }
  for (const file of files) {
    if (file.status === "failed") lines.push(`Could not install ${file.path}: ${file.message}`);
    if (file.status === "conflict") lines.push(`Left ${file.path} alone: ${file.message}`);
  }
  if (report.commands.length > 0) {
    const needs = count("needs_admin");
    lines.push(
      report.platform === "win32"
        ? `${needs > 0 ? `${plural(needs, "file")} need an administrator. ` : ""}Run in PowerShell as administrator:`
        : `${needs > 0 ? `${plural(needs, "file")} need an admin. ` : ""}Run (selfhost never runs sudo itself):`,
    );
    for (const command of report.commands) lines.push(`  ${command}`);
  }
  return lines;
}

/** Where join and sync keep staged copies and the record of what selfhost wrote. */
export const managedDir = (configPath: string) => join(dirname(configPath), "managed");
export const knownPath = (configPath: string) => join(managedDir(configPath), "known.json");
