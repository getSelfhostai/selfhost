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

export const HETZNER_API = "https://api.hetzner.cloud/v1";
export const HETZNER_METADATA = "http://169.254.169.254/hetzner/v1/metadata/public-ipv4";
const IMAGE = "ubuntu-24.04";
const USER_DATA_LIMIT = 32 * 1024;
const LABELS = { "managed-by": "selfhost" };

/** Codes that mean "this server type cannot be had here right now": try the next one. */
const TRY_NEXT_TYPE = new Set(["resource_unavailable", "placement_error", "unavailable"]);

export const HETZNER_RULES = [
  { description: "SSH", direction: "in", protocol: "tcp", port: "22" },
  {
    description: "HTTP, for certificates and the redirect",
    direction: "in",
    protocol: "tcp",
    port: "80",
  },
  { description: "HTTPS", direction: "in", protocol: "tcp", port: "443" },
  { description: "HTTP/3", direction: "in", protocol: "udp", port: "443" },
].map((rule) => ({ ...rule, source_ips: ["0.0.0.0/0", "::/0"] }));

interface SshKeys {
  ssh_keys: { id: number; name: string; fingerprint: string }[];
}
interface CreatedKey {
  ssh_key: { id: number; name: string };
}
interface CreatedFirewall {
  firewall: { id: number; name: string };
}
interface ServerAnswer {
  server: {
    id: number;
    name: string;
    public_net: { ipv4: { ip: string } | null };
    server_type: { name: string };
  };
}

const deleteWith = (path: string) =>
  `curl -fsS -X DELETE -H "Authorization: Bearer $HCLOUD_TOKEN" ${HETZNER_API}${path}`;

const metadata: DomainSource = { metadataUrl: HETZNER_METADATA, from: "Hetzner" };
const domainSource = (plan: UpPlan): DomainSource =>
  plan.domain ? { domain: plan.domain } : metadata;

export const hetzner: ProviderDriver = {
  describe(plan, userData) {
    const script = userData(domainSource(plan));
    const key = plan.publicKey?.path ?? "your SSH public key";
    return {
      steps: [
        `Find ${key} in the Hetzner project by fingerprint, or add it`,
        `Create firewall ${plan.name}: inbound TCP 22, 80 and 443 and UDP 443 only`,
        `Create server ${plan.name} (${plan.sizes.join(", else ")}; ${IMAGE}; ${plan.region}) with the firewall, the key and the user-data below`,
      ],
      userData: script,
      userDataNote: `${kb(Buffer.byteLength(script))} of the ${kb(USER_DATA_LIMIT)} Hetzner accepts`,
    };
  },

  async deploy({ io, plan, tracker, log, userData }: DeployContext): Promise<Deployed> {
    const token = io.env.HCLOUD_TOKEN?.trim();
    if (!token) {
      throw new UpError(
        "HCLOUD_TOKEN is not set. Create a read and write API token in the Hetzner Cloud console (your project, Security, API tokens) and export it as HCLOUD_TOKEN.",
      );
    }
    const key = plan.publicKey;
    if (!key) throw new UpError("No SSH public key to put on the server: pass --ssh-key <file>");
    const script = userData(domainSource(plan));
    checkUserDataSize(Buffer.byteLength(script), USER_DATA_LIMIT, "Hetzner");
    const api = jsonApi(io.fetch, "Hetzner", HETZNER_API, token);

    const found = await api<SshKeys>(
      "GET",
      `/ssh_keys?fingerprint=${encodeURIComponent(key.fingerprint)}`,
    );
    let keyId = found.ssh_keys[0]?.id;
    if (keyId === undefined) {
      log(`Adding SSH key ${key.path} to the Hetzner project as ${plan.name}`);
      const created = await api<CreatedKey>("POST", "/ssh_keys", {
        name: plan.name,
        public_key: key.key,
        labels: LABELS,
      });
      keyId = created.ssh_key.id;
      tracker.add({
        provider: "hetzner",
        kind: "ssh key",
        id: String(keyId),
        name: created.ssh_key.name,
        delete: deleteWith(`/ssh_keys/${keyId}`),
      });
    } else {
      log(`Using SSH key ${found.ssh_keys[0]?.name} already in the Hetzner project`);
    }

    log(`Creating firewall ${plan.name}: inbound 22, 80 and 443 only`);
    const { firewall } = await api<CreatedFirewall>("POST", "/firewalls", {
      name: plan.name,
      labels: LABELS,
      rules: HETZNER_RULES,
    });
    tracker.add({
      provider: "hetzner",
      kind: "firewall",
      id: String(firewall.id),
      name: firewall.name,
      delete: deleteWith(`/firewalls/${firewall.id}`),
    });

    let answer: ServerAnswer | undefined;
    for (const [index, size] of plan.sizes.entries()) {
      log(`Creating server ${plan.name} (${size}, ${IMAGE}) in ${plan.region}`);
      try {
        answer = await api<ServerAnswer>("POST", "/servers", {
          name: plan.name,
          server_type: size,
          image: IMAGE,
          location: plan.region,
          ssh_keys: [keyId],
          firewalls: [{ firewall: firewall.id }],
          user_data: script,
          labels: LABELS,
          public_net: { enable_ipv4: true, enable_ipv6: true },
        });
        break;
      } catch (error) {
        const next = plan.sizes[index + 1];
        if (!(error instanceof CloudApiError && TRY_NEXT_TYPE.has(error.code)) || !next)
          throw error;
        log(`  ${size} is not available there (${error.code}); trying ${next}`);
      }
    }
    if (!answer) throw new Error("No server type to try: pass --size");
    const { server } = answer;
    tracker.add({
      provider: "hetzner",
      kind: "server",
      id: String(server.id),
      name: server.name,
      delete: deleteWith(`/servers/${server.id}`),
    });

    let ip = server.public_net.ipv4?.ip;
    for (let attempt = 0; !ip && attempt < 30; attempt++) {
      await io.sleep(2000);
      ip = (await api<ServerAnswer>("GET", `/servers/${server.id}`)).server.public_net.ipv4?.ip;
    }
    if (!ip) throw new Error(`Hetzner gave server ${server.id} no public IPv4 address`);
    return {
      ip,
      domain: plan.domain ?? sslipName(ip),
      region: plan.region,
      size: server.server_type.name,
      ssh: `ssh root@${ip}`,
      target: cloudTarget(plan, io, "root", ip),
      sudo: false,
      existingInstall: false,
    };
  },
};
