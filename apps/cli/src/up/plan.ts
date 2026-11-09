import type { Fetch } from "../team/client.js";
import type { PublicKey } from "./cloud-api.js";
import type { ImageCheck } from "./registry.js";
import type { Exec, Tracker } from "./resources.js";
import type { Provider, SizeRecommendation } from "./size.js";
import type { DomainSource, SigninSettings, StackSettings } from "./stack.js";

export interface UpIo {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  /** Where the deployment and any team membership are saved. */
  configPath: string;
  /** Cloud APIs and the health check. */
  fetch: Fetch;
  /** ssh and the aws CLI. */
  exec: Exec;
  sleep: (ms: number) => Promise<void>;
  now?: Date;
  randomHex?: (bytes: number) => string;
  /** Whether the image tag is in its registry. Default: an anonymous manifest check. */
  imageExists?: ImageCheck;
}

export interface SshTarget {
  user: string;
  host: string;
  port: number | null;
  /** Private key file for ssh -i; null uses ssh-agent and ~/.ssh as ssh does. */
  identity: string | null;
  /**
   * For a server selfhost up just created: its host key is kept under this name in knownHosts,
   * so an old key for a reused IP address never gets in the way. Null uses ~/.ssh/known_hosts.
   */
  hostKeyAlias: string | null;
  knownHosts: string | null;
}

/** Everything decided before anything is created. */
export interface UpPlan {
  provider: Provider;
  /** Name for the server and what goes with it, like selfhost-3f9a. */
  name: string;
  /** Hetzner location, DigitalOcean or AWS region; null for SSH or the aws CLI's default. */
  region: string | null;
  /** Server types to try in order; empty for SSH. */
  sizes: string[];
  recommendation: SizeRecommendation;
  /** Root disk to launch with where the provider sizes it at launch (AWS). */
  diskGb: number;
  /** --domain; null means a sslip.io name for the server's IP, or the SSH host name. */
  domain: string | null;
  settings: StackSettings;
  /** Console sign-in, turned on over SSH once the server answers; null leaves it off. */
  signin: SigninSettings | null;
  /** The key to put on a new cloud server; null for SSH, or in a dry run without one. */
  publicKey: PublicKey | null;
  ssh: SshTarget | null;
}

export interface DeployContext {
  io: UpIo;
  plan: UpPlan;
  tracker: Tracker;
  /** Progress for people; quiet with --json. */
  log: (line: string) => void;
  /** The bootstrap script (cloud-init user-data) for a way of finding the domain. */
  userData: (domain: DomainSource) => string;
}

export interface Deployed {
  /** How selfhost up reaches the server over SSH to read the tokens and turn on sign-in. */
  target: SshTarget;
  ip: string | null;
  domain: string;
  region: string | null;
  size: string | null;
  /** How to log in, like `ssh root@1.2.3.4`. */
  ssh: string;
  /** Whether commands on the server need sudo. */
  sudo: boolean;
  /** The server already ran selfhost: install.sh kept its secrets, and no team is created. */
  existingInstall: boolean;
}

export interface Described {
  steps: string[];
  userData: string;
  /** How the user-data is sent, like "gzip, 4.1 KB of the 16 KB AWS allows". */
  userDataNote: string;
}

export interface ProviderDriver {
  /** What would happen, for --dry-run. Makes no request and runs nothing. */
  describe(plan: UpPlan, userData: (domain: DomainSource) => string): Described;
  deploy(ctx: DeployContext): Promise<Deployed>;
}

export const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** Fails before anything is created when the user-data is over the provider's limit. */
export function checkUserDataSize(bytes: number, limit: number, provider: string): void {
  if (bytes > limit) {
    throw new Error(
      `The cloud-init user-data is ${kb(bytes)}, over the ${kb(limit)} ${provider} accepts.`,
    );
  }
}
