import { CloudApiError, jsonApi } from "./cloud-api.js";
import {
  checkUserDataSize,
  type DeployContext,
  type Deployed,
  kb,
  type ProviderDriver,
  type UpPlan,
} from "./plan.js";
import { UpError } from "./resources.js";
import { cloudTarget } from "./ssh.js";
import { type DomainSource, sslipName } from "./stack.js";

export const DIGITALOCEAN_API = "https://api.digitalocean.com/v2";
export const DIGITALOCEAN_METADATA =
  "http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address";
const IMAGE = "ubuntu-24-04-x64";
const USER_DATA_LIMIT = 64 * 1024;
const TAG = "selfhost";
const ANYWHERE = { addresses: ["0.0.0.0/0", "::/0"] };

export const DIGITALOCEAN_INBOUND = [
  { protocol: "tcp", ports: "22", sources: ANYWHERE },
  { protocol: "tcp", ports: "80", sources: ANYWHERE },
  { protocol: "tcp", ports: "443", sources: ANYWHERE },
  { protocol: "udp", ports: "443", sources: ANYWHERE },
];
// A DigitalOcean firewall blocks all outbound traffic it does not allow.
export const DIGITALOCEAN_OUTBOUND = [
  { protocol: "tcp", ports: "0", destinations: ANYWHERE },
  { protocol: "udp", ports: "0", destinations: ANYWHERE },
  { protocol: "icmp", ports: "0", destinations: ANYWHERE },
];

interface KeyAnswer {
  ssh_key: { id: number; name: string; fingerprint: string };
}
interface Droplet {
  id: number;
  name: string;
  status: string;
  size_slug: string;
  networks: { v4: { ip_address: string; type: string }[] };
}
interface FirewallAnswer {
  firewall: { id: string; name: string };
}

/** The DigitalOcean token: DIGITALOCEAN_TOKEN, or DIGITALOCEAN_ACCESS_TOKEN as doctl reads it. */
export const digitalOceanToken = (env: NodeJS.ProcessEnv) =>
  env.DIGITALOCEAN_TOKEN?.trim() || env.DIGITALOCEAN_ACCESS_TOKEN?.trim() || undefined;

const deleteWith = (path: string) =>
  `curl -fsS -X DELETE -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" ${DIGITALOCEAN_API}${path}`;

const metadata: DomainSource = { metadataUrl: DIGITALOCEAN_METADATA, from: "DigitalOcean" };
const domainSource = (plan: UpPlan): DomainSource =>
  plan.domain ? { domain: plan.domain } : metadata;

const publicIp = (droplet: Droplet) =>
  droplet.networks.v4.find((network) => network.type === "public")?.ip_address;

export const digitalocean: ProviderDriver = {
  describe(plan, userData) {
    const script = userData(domainSource(plan));
    const key = plan.publicKey?.path ?? "your SSH public key";
    return {
      steps: [
        `Find ${key} in the DigitalOcean account by fingerprint, or add it`,
        `Create droplet ${plan.name} (${plan.sizes[0]}; ${IMAGE}; ${plan.region}) with the key and the user-data below`,
        `Create firewall ${plan.name} for the droplet: inbound TCP 22, 80 and 443 and UDP 443 only`,
      ],
      userData: script,
      userDataNote: `${kb(Buffer.byteLength(script))} of the ${kb(USER_DATA_LIMIT)} DigitalOcean accepts`,
    };
  },

  async deploy({ io, plan, tracker, log, userData }: DeployContext): Promise<Deployed> {
    const token = digitalOceanToken(io.env);
    if (!token) {
      throw new UpError(
        "DIGITALOCEAN_TOKEN is not set. Create a personal access token with read and write scope in the DigitalOcean control panel (API, Tokens) and export it as DIGITALOCEAN_TOKEN.",
      );
    }
    const key = plan.publicKey;
    if (!key) throw new UpError("No SSH public key to put on the droplet: pass --ssh-key <file>");
    const script = userData(domainSource(plan));
    checkUserDataSize(Buffer.byteLength(script), USER_DATA_LIMIT, "DigitalOcean");
    const api = jsonApi(io.fetch, "DigitalOcean", DIGITALOCEAN_API, token);

    try {
      const found = await api<KeyAnswer>(
        "GET",
        `/account/keys/${encodeURIComponent(key.fingerprint)}`,
      );
      log(`Using SSH key ${found.ssh_key.name} already in the DigitalOcean account`);
    } catch (error) {
      if (!(error instanceof CloudApiError && error.status === 404)) throw error;
      log(`Adding SSH key ${key.path} to the DigitalOcean account as ${plan.name}`);
      const { ssh_key } = await api<KeyAnswer>("POST", "/account/keys", {
        name: plan.name,
        public_key: key.key,
      });
      tracker.add({
        provider: "digitalocean",
        kind: "ssh key",
        id: String(ssh_key.id),
        name: ssh_key.name,
        delete: deleteWith(`/account/keys/${ssh_key.id}`),
      });
    }

    const size = plan.sizes[0];
    if (!size) throw new Error("No droplet size to use: pass --size");
    log(`Creating droplet ${plan.name} (${size}, ${IMAGE}) in ${plan.region}`);
    const created = await api<{ droplet: Droplet }>("POST", "/droplets", {
      name: plan.name,
      region: plan.region,
      size,
      image: IMAGE,
      ssh_keys: [key.fingerprint],
      ipv6: true,
      monitoring: true,
      tags: [TAG],
      user_data: script,
    });
    let droplet = created.droplet;
    tracker.add({
      provider: "digitalocean",
      kind: "droplet",
      id: String(droplet.id),
      name: droplet.name,
      delete: deleteWith(`/droplets/${droplet.id}`),
    });

    for (let attempt = 0; !(droplet.status === "active" && publicIp(droplet)); attempt++) {
      if (attempt >= 60) {
        throw new Error(`Droplet ${droplet.id} is still ${droplet.status} after 5 minutes`);
      }
      await io.sleep(5000);
      droplet = (await api<{ droplet: Droplet }>("GET", `/droplets/${droplet.id}`)).droplet;
    }
    const ip = publicIp(droplet) as string;

    log(`Creating firewall ${plan.name}: inbound 22, 80 and 443 only`);
    const { firewall } = await api<FirewallAnswer>("POST", "/firewalls", {
      name: plan.name,
      inbound_rules: DIGITALOCEAN_INBOUND,
      outbound_rules: DIGITALOCEAN_OUTBOUND,
      droplet_ids: [droplet.id],
    });
    tracker.add({
      provider: "digitalocean",
      kind: "firewall",
      id: firewall.id,
      name: firewall.name,
      delete: deleteWith(`/firewalls/${firewall.id}`),
    });

    return {
      ip,
      domain: plan.domain ?? sslipName(ip),
      region: plan.region,
      size: droplet.size_slug,
      ssh: `ssh root@${ip}`,
      target: cloudTarget(plan, io, "root", ip),
      sudo: false,
      existingInstall: false,
    };
  },
};
