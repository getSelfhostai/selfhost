import type { SandboxBilling } from "@selfhost/schema";
import type { RuntimeKind } from "./types.js";

/** vCPUs and memory of a sandbox. */
export interface Size {
  cpu: number;
  memoryGiB: number;
}

/** What selfhost knows about each runtime without calling it. */
export interface RuntimeInfo {
  kind: RuntimeKind;
  name: string;
  billing: SandboxBilling;
  /** The size a sandbox gets when the spec asks for none. */
  defaultSize: Size;
  /** Whether a spec's size is applied at create; E2B sizes come from the template. */
  sizeAtCreate: boolean;
  /**
   * Regions a spec may name: a list, "any" for the team's own infrastructure (the region is
   * wherever it runs), or "none" when the provider places sandboxes itself.
   */
  regions: readonly string[] | "any" | "none";
  /** USD per vCPU-second and per GiB-second of memory at list price; undefined for own infra. */
  price?: {
    cpuSecond: number;
    memoryGiBSecond: number;
    /** Disk past the free allowance, per GiB-second. */
    diskGiBSecond?: number;
    freeDiskGiB?: number;
    regionFactor?: number;
  };
  /** Where the price comes from, and when it was read. */
  priceSource?: string;
  /** The SDK the adapter drives, as an optional peer dependency, or undefined for plain HTTP. */
  sdk?: { name: string; version: string; license: string };
  docs: string;
}

/** Prices read from each provider's pricing page on this day. */
export const PRICES_AS_OF = "2026-11-09";

export const RUNTIMES: Readonly<Record<RuntimeKind, RuntimeInfo>> = {
  e2b: {
    kind: "e2b",
    name: "E2B",
    billing: "reserved",
    defaultSize: { cpu: 2, memoryGiB: 4 },
    sizeAtCreate: false,
    regions: "none",
    // $0.000014 per vCPU-second, $0.0000045 per GiB-second, billed per second while running.
    price: { cpuSecond: 0.000014, memoryGiBSecond: 0.0000045 },
    priceSource: "https://e2b.dev/pricing",
    sdk: { name: "e2b", version: "2.59.0", license: "MIT" },
    docs: "https://e2b.dev/docs",
  },
  daytona: {
    kind: "daytona",
    name: "Daytona",
    billing: "reserved",
    defaultSize: { cpu: 1, memoryGiB: 1 },
    sizeAtCreate: true,
    regions: ["us", "eu"],
    // $0.0504 per vCPU-hour, $0.0162 per GiB-hour; the first 5 GiB of disk are free.
    price: {
      cpuSecond: 0.0504 / 3600,
      memoryGiBSecond: 0.0162 / 3600,
      diskGiBSecond: 0.000108 / 3600,
      freeDiskGiB: 5,
    },
    priceSource: "https://www.daytona.io/pricing",
    sdk: { name: "@daytona/sdk", version: "0.226.1", license: "Apache-2.0" },
    docs: "https://www.daytona.io/docs/en/typescript-sdk",
  },
  modal: {
    kind: "modal",
    name: "Modal",
    billing: "reserved",
    defaultSize: { cpu: 2, memoryGiB: 4 },
    sizeAtCreate: true,
    regions: [
      "us-east",
      "us-west",
      "us-central",
      "eu-west",
      "eu-north",
      "ap-south",
      "ap-northeast",
    ],
    // Sandboxes: $0.00003942 per physical core-second (2 vCPUs), $0.00000667 per GiB-second.
    // Picking a region costs 1.15 to 1.75 times as much; the floor is used.
    price: { cpuSecond: 0.00003942 / 2, memoryGiBSecond: 0.00000667, regionFactor: 1.15 },
    priceSource: "https://modal.com/pricing",
    sdk: { name: "modal", version: "0.11.1", license: "Apache-2.0" },
    docs: "https://modal.com/docs/guide/sandboxes",
  },
  coder: {
    kind: "coder",
    name: "Coder",
    billing: "reserved",
    defaultSize: { cpu: 2, memoryGiB: 4 },
    sizeAtCreate: false,
    regions: "any",
    docs: "https://coder.com/docs/reference/api",
  },
  opensandbox: {
    kind: "opensandbox",
    name: "OpenSandbox",
    billing: "reserved",
    defaultSize: { cpu: 1, memoryGiB: 2 },
    sizeAtCreate: true,
    regions: "any",
    sdk: { name: "@alibaba-group/opensandbox", version: "1.1.1", license: "Apache-2.0" },
    docs: "https://github.com/opensandbox-group/OpenSandbox",
  },
};

/** The size a sandbox gets: the asked-for one where the runtime applies it, else its default. */
export function sizeFor(kind: RuntimeKind, asked?: { cpu?: number; memoryGiB?: number }): Size {
  const info = RUNTIMES[kind];
  if (!info.sizeAtCreate || !asked) return info.defaultSize;
  return {
    cpu: asked.cpu ?? info.defaultSize.cpu,
    memoryGiB: asked.memoryGiB ?? info.defaultSize.memoryGiB,
  };
}

/**
 * List price of one running hour of a sandbox this size, in USD. usdPerHour (from
 * [runtime.providers]) wins; undefined when the runtime has no published rate and none is set.
 */
export function hourlyPrice(
  kind: RuntimeKind,
  size: Size,
  options: { usdPerHour?: number; region?: string; diskGiB?: number } = {},
): number | undefined {
  if (options.usdPerHour !== undefined) return options.usdPerHour;
  const price = RUNTIMES[kind].price;
  if (!price) return undefined;
  const factor = options.region && price.regionFactor ? price.regionFactor : 1;
  const disk = Math.max(0, (options.diskGiB ?? 0) - (price.freeDiskGiB ?? 0));
  const perSecond =
    size.cpu * price.cpuSecond +
    size.memoryGiB * price.memoryGiBSecond +
    disk * (price.diskGiBSecond ?? 0);
  return perSecond * 3600 * factor;
}

/** Dollars for `seconds` of running at `usdPerHour`, rounded to 6 decimals. */
export function costOf(seconds: number, usdPerHour: number | undefined): number {
  if (usdPerHour === undefined) return 0;
  return Math.round(((Math.max(0, seconds) * usdPerHour) / 3600) * 1e6) / 1e6;
}

/** Whether a runtime can place a sandbox in `region`. */
export function servesRegion(kind: RuntimeKind, region: string): boolean {
  const regions = RUNTIMES[kind].regions;
  if (regions === "any") return true;
  if (regions === "none") return false;
  return regions.includes(region);
}
