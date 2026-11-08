/** Where `selfhost up` can put the team server. */
export const PROVIDERS = ["hetzner", "digitalocean", "aws", "ssh"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type CloudProvider = Exclude<Provider, "ssh">;
export const CLOUD_PROVIDERS: readonly CloudProvider[] = ["hetzner", "digitalocean", "aws"];

export interface ServerType {
  name: string;
  vcpus: number;
  memory_gb: number;
  /** The type's own disk, or null where the disk is sized at launch (AWS EBS). */
  disk_gb: number | null;
}

export interface Tier {
  name: "small" | "medium" | "large";
  max_people: number;
  max_events_per_day: number;
  vcpus: number;
  memory_gb: number;
  /** Per provider, in the order to try them: later ones stand in when one is not on sale. */
  types: Record<CloudProvider, readonly ServerType[]>;
}

const type = (name: string, vcpus: number, memory_gb: number, disk_gb: number | null) => ({
  name,
  vcpus,
  memory_gb,
  disk_gb,
});

/**
 * Server sizes by load. The stack (Postgres, the API, the collector, Caddy and oauth2-proxy)
 * idles at about 0.5 GB of memory, so a small team runs on 2 cores and 4 GB with room to spare.
 */
export const TIERS: readonly Tier[] = [
  {
    name: "small",
    max_people: 15,
    max_events_per_day: 50_000,
    vcpus: 2,
    memory_gb: 4,
    types: {
      hetzner: [type("cx23", 2, 4, 40), type("cpx22", 2, 4, 80)],
      digitalocean: [type("s-2vcpu-4gb", 2, 4, 80)],
      aws: [type("t3.medium", 2, 4, null)],
    },
  },
  {
    name: "medium",
    max_people: 60,
    max_events_per_day: 250_000,
    vcpus: 4,
    memory_gb: 8,
    types: {
      hetzner: [type("cx33", 4, 8, 80), type("cpx32", 4, 8, 160)],
      digitalocean: [type("s-4vcpu-8gb", 4, 8, 160)],
      aws: [type("t3.xlarge", 4, 16, null)],
    },
  },
  {
    name: "large",
    max_people: 250,
    max_events_per_day: 1_000_000,
    vcpus: 8,
    memory_gb: 16,
    types: {
      hetzner: [type("cx43", 8, 16, 160), type("cpx42", 8, 16, 320)],
      digitalocean: [type("s-8vcpu-16gb", 8, 16, 320)],
      aws: [type("m7i.2xlarge", 8, 32, null)],
    },
  },
];

/** Agent events a person's hooks and OpenTelemetry send in a working day, when not given. */
export const EVENTS_PER_PERSON_PER_DAY = 1500;
/** The server's default retention (ledger.retention_days). */
export const RETENTION_DAYS = 90;
/** Bytes an event takes in Postgres with its indexes, and in a compressed pg_dump. */
export const DATABASE_BYTES_PER_EVENT = 2000;
export const BACKUP_BYTES_PER_EVENT = 300;
/** The OS, Docker and the images. */
export const SYSTEM_GB = 10;
/** Smallest disk to launch with where the disk is sized at launch. */
export const MIN_DISK_GB = 40;

export interface SizeInput {
  people: number;
  /** Default: EVENTS_PER_PERSON_PER_DAY for each person. */
  eventsPerDay?: number;
  /** Days of daily backups kept on the server. */
  backupKeepDays: number;
}

export interface SizedType extends ServerType {
  /** Whether the type's disk holds the disk estimate. Always true where it is sized at launch. */
  fits_disk: boolean;
}

export interface SizeRecommendation {
  tier: Tier["name"];
  people: number;
  events_per_day: number;
  /** True when events_per_day was worked out from the team size. */
  events_estimated: boolean;
  vcpus: number;
  memory_gb: number;
  disk: { total_gb: number; database_gb: number; backups_gb: number; system_gb: number };
  /** Per provider, in the order to try; types whose disk holds the estimate come first. */
  types: Record<CloudProvider, SizedType[]>;
  notes: string[];
}

const GB = 1e9;
const oneDecimal = (value: number) => Math.round(value * 10) / 10;

/**
 * Recommends a server size from the team size and event volume. Pure: the same input always
 * gives the same answer, and nothing is looked up.
 */
export function recommendSize(input: SizeInput): SizeRecommendation {
  const { people, backupKeepDays } = input;
  if (!Number.isInteger(people) || people < 1) {
    throw new Error(`team size must be a whole number of people, at least 1, got ${people}`);
  }
  const eventsPerDay = input.eventsPerDay ?? people * EVENTS_PER_PERSON_PER_DAY;
  if (!Number.isFinite(eventsPerDay) || eventsPerDay < 0) {
    throw new Error(`events per day must be a number, 0 or more, got ${input.eventsPerDay}`);
  }
  const fitting = TIERS.find(
    (tier) => people <= tier.max_people && eventsPerDay <= tier.max_events_per_day,
  );
  const tier = fitting ?? (TIERS[TIERS.length - 1] as Tier);

  const stored = eventsPerDay * RETENTION_DAYS;
  const databaseGb = (stored * DATABASE_BYTES_PER_EVENT) / GB;
  const backupsGb = (backupKeepDays * stored * BACKUP_BYTES_PER_EVENT) / GB;
  const totalGb = Math.ceil(databaseGb + backupsGb + SYSTEM_GB);

  const types = {} as Record<CloudProvider, SizedType[]>;
  for (const provider of Object.keys(tier.types) as CloudProvider[]) {
    const sized = tier.types[provider].map((entry) => ({
      ...entry,
      fits_disk: entry.disk_gb === null || entry.disk_gb >= totalGb,
    }));
    types[provider] = [
      ...sized.filter((entry) => entry.fits_disk),
      ...sized.filter((entry) => !entry.fits_disk),
    ];
  }

  const notes: string[] = [];
  if (!fitting) {
    notes.push(
      `${people} people and ${eventsPerDay.toLocaleString("en-US")} events a day is past what one server runs comfortably: start on the large size and move Postgres to a managed database or its own server.`,
    );
  }
  return {
    tier: tier.name,
    people,
    events_per_day: eventsPerDay,
    events_estimated: input.eventsPerDay === undefined,
    vcpus: tier.vcpus,
    memory_gb: tier.memory_gb,
    disk: {
      total_gb: totalGb,
      database_gb: oneDecimal(databaseGb),
      backups_gb: oneDecimal(backupsGb),
      system_gb: SYSTEM_GB,
    },
    types,
    notes,
  };
}

/** Disk to launch with where it is sized at launch: the estimate in tens of GB, 40 at least. */
export function launchDiskGb(recommendation: SizeRecommendation): number {
  return Math.max(MIN_DISK_GB, Math.ceil(recommendation.disk.total_gb / 10) * 10);
}
