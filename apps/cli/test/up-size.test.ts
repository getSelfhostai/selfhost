import { describe, expect, it } from "vitest";
import { EVENTS_PER_PERSON_PER_DAY, launchDiskGb, recommendSize, TIERS } from "../src/up/size.js";

const names = (types: { name: string }[]) => types.map((type) => type.name);

describe("recommendSize", () => {
  it("puts a small team on a 2-core server at every provider", () => {
    const small = recommendSize({ people: 5, backupKeepDays: 14 });
    expect(small).toMatchObject({
      tier: "small",
      people: 5,
      events_per_day: 5 * EVENTS_PER_PERSON_PER_DAY,
      events_estimated: true,
      vcpus: 2,
      memory_gb: 4,
      notes: [],
    });
    expect(names(small.types.hetzner)).toEqual(["cx23", "cpx22"]);
    expect(names(small.types.digitalocean)).toEqual(["s-2vcpu-4gb"]);
    expect(names(small.types.aws)).toEqual(["t3.medium"]);
    for (const types of Object.values(small.types)) {
      for (const type of types) {
        expect(type.vcpus, type.name).toBe(2);
        expect(type.memory_gb, type.name).toBeGreaterThanOrEqual(4);
        expect(type.fits_disk, type.name).toBe(true);
      }
    }
  });

  it("works out the disk from events, the 90 day retention and the kept backups", () => {
    const { disk } = recommendSize({ people: 5, eventsPerDay: 10_000, backupKeepDays: 14 });
    // 10,000 a day for 90 days: 900,000 events at 2 KB, and 14 dumps of them at 0.3 KB.
    expect(disk).toEqual({ total_gb: 16, database_gb: 1.8, backups_gb: 3.8, system_gb: 10 });
  });

  it.each([
    [1, undefined, "small"],
    [15, undefined, "small"],
    [16, undefined, "medium"],
    [3, 50_000, "small"],
    [3, 50_001, "medium"],
    [60, undefined, "medium"],
    [61, undefined, "large"],
    [10, 400_000, "large"],
    [250, 1_000_000, "large"],
  ] as const)("%s people and %s events a day is %s", (people, eventsPerDay, tier) => {
    expect(recommendSize({ people, eventsPerDay, backupKeepDays: 14 }).tier).toBe(tier);
  });

  it("grows with the team: more cores and memory at each step", () => {
    const sizes = [5, 40, 200].map((people) => recommendSize({ people, backupKeepDays: 14 }));
    expect(sizes.map((size) => size.tier)).toEqual(["small", "medium", "large"]);
    expect(sizes.map((size) => size.vcpus)).toEqual([2, 4, 8]);
    expect(sizes.map((size) => size.memory_gb)).toEqual([4, 8, 16]);
  });

  it("tries first the type whose disk holds the estimate", () => {
    // 50,000 a day for 90 days is 4.5 million events: 9 GB of database and 14 dumps of 1.35 GB.
    const busy = recommendSize({ people: 10, eventsPerDay: 50_000, backupKeepDays: 14 });
    expect(busy.disk.total_gb).toBe(38);
    expect(names(busy.types.hetzner)).toEqual(["cx23", "cpx22"]);
    const longer = recommendSize({ people: 10, eventsPerDay: 50_000, backupKeepDays: 30 });
    expect(longer.disk.total_gb).toBe(60);
    expect(names(longer.types.hetzner)).toEqual(["cpx22", "cx23"]);
    expect(longer.types.hetzner.map((type) => type.fits_disk)).toEqual([true, false]);
    expect(longer.types.aws[0]?.fits_disk).toBe(true);
  });

  it("says when one server is not enough", () => {
    const huge = recommendSize({ people: 400, backupKeepDays: 14 });
    expect(huge.tier).toBe("large");
    expect(huge.notes).toEqual([
      expect.stringMatching(/^400 people and 600,000 events a day is past what one server runs/),
    ]);
  });

  it("refuses team sizes and event counts that are not counts", () => {
    expect(() => recommendSize({ people: 0, backupKeepDays: 14 })).toThrow(/at least 1/);
    expect(() => recommendSize({ people: 2.5, backupKeepDays: 14 })).toThrow(/whole number/);
    expect(() => recommendSize({ people: 2, eventsPerDay: -1, backupKeepDays: 14 })).toThrow(
      /0 or more/,
    );
  });

  it("is pure: the same input gives the same answer", () => {
    const input = { people: 12, eventsPerDay: 30_000, backupKeepDays: 7 };
    expect(recommendSize(input)).toEqual(recommendSize(input));
  });

  it("sizes the AWS disk at launch: the estimate in tens of GB, 40 at least", () => {
    expect(launchDiskGb(recommendSize({ people: 2, backupKeepDays: 14 }))).toBe(40);
    expect(launchDiskGb(recommendSize({ people: 40, backupKeepDays: 14 }))).toBe(50);
  });

  it("lists the tiers smallest first, each type at least the tier's cores and memory", () => {
    for (const [index, tier] of TIERS.entries()) {
      if (index > 0) expect(tier.vcpus).toBeGreaterThan(TIERS[index - 1]?.vcpus ?? 0);
      for (const types of Object.values(tier.types)) {
        for (const type of types) {
          expect(type.vcpus, type.name).toBeGreaterThanOrEqual(tier.vcpus);
          expect(type.memory_gb, type.name).toBeGreaterThanOrEqual(tier.memory_gb);
        }
      }
    }
  });
});
