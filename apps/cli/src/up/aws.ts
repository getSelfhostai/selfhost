import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  checkUserDataSize,
  type DeployContext,
  type Deployed,
  kb,
  type ProviderDriver,
  type UpIo,
  type UpPlan,
} from "./plan.js";
import { UpError } from "./resources.js";
import { cloudTarget } from "./ssh.js";
import { sslipName } from "./stack.js";

/**
 * AWS goes through the aws CLI rather than an SDK: the AWS SDK would add megabytes to every
 * selfhost binary for one command, and the CLI already handles profiles, SSO and MFA.
 */

/** Ubuntu 24.04 LTS for x86, looked up by EC2 itself from Canonical's public SSM parameter. */
export const AWS_IMAGE =
  "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";
/** EC2 takes 16 KB of user-data before base64; the script goes gzip compressed. */
const USER_DATA_LIMIT = 16 * 1024;
const INSTALL_DOCS =
  "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

const tags = (resourceType: string, name: string) => ({
  ResourceType: resourceType,
  Tags: [
    { Key: "Name", Value: name },
    { Key: "managed-by", Value: "selfhost" },
  ],
});

const ingress = (protocol: "tcp" | "udp", port: number) => ({
  IpProtocol: protocol,
  FromPort: port,
  ToPort: port,
  IpRanges: [{ CidrIp: "0.0.0.0/0" }],
  Ipv6Ranges: [{ CidrIpv6: "::/0" }],
});
export const AWS_INGRESS = [
  ingress("tcp", 22),
  ingress("tcp", 80),
  ingress("tcp", 443),
  ingress("udp", 443),
];

/** The user-data as EC2 gets it: gzip, which cloud-init unpacks. */
export const awsUserData = (script: string) => gzipSync(Buffer.from(script, "utf8"), { level: 9 });

/** The region: --region, AWS_REGION, AWS_DEFAULT_REGION, else the aws CLI's configured one. */
export async function awsRegion(plan: UpPlan, io: UpIo): Promise<string> {
  const given = plan.region ?? (io.env.AWS_REGION?.trim() || io.env.AWS_DEFAULT_REGION?.trim());
  if (given) return given;
  const configured = await io.exec("aws", ["configure", "get", "region"]);
  const region = configured.code === 0 ? configured.stdout.trim() : "";
  if (!region) throw new UpError("No AWS region: pass --region, or set AWS_REGION.");
  return region;
}

export const aws: ProviderDriver = {
  describe(plan, userData) {
    const where = plan.region ?? "the region from AWS_REGION or the aws CLI";
    const script = userData({ domain: plan.domain ?? "<elastic ip>.sslip.io" });
    const zipped = awsUserData(script).length;
    return {
      steps: [
        `Check the aws CLI is signed in (aws sts get-caller-identity), in ${where}`,
        `Allocate an Elastic IP ${plan.name}, so the address survives a stop and start`,
        `Import ${plan.publicKey?.path ?? "your SSH public key"} as key pair ${plan.name}`,
        `Create security group ${plan.name} in the default VPC: inbound TCP 22, 80 and 443 and UDP 443 only`,
        `Launch instance ${plan.name} (${plan.sizes[0]}, Ubuntu 24.04, ${plan.diskGb} GB encrypted gp3, IMDSv2 only) with the user-data below`,
        "Attach the Elastic IP once it runs",
      ],
      userData: script,
      userDataNote: `sent gzip compressed, ${kb(zipped)} of the ${kb(USER_DATA_LIMIT)} AWS accepts`,
    };
  },

  async deploy({ io, plan, tracker, log, userData }: DeployContext): Promise<Deployed> {
    const version = await io.exec("aws", ["--version"]);
    if (version.code !== 0) {
      throw new UpError(
        version.code === 127
          ? `AWS needs the aws CLI v2 on PATH: ${INSTALL_DOCS}`
          : `The aws CLI did not run: ${version.stderr.trim() || version.stdout.trim()}`,
      );
    }
    const key = plan.publicKey;
    if (!key) throw new UpError("No SSH public key to put on the instance: pass --ssh-key <file>");
    const region = await awsRegion(plan, io);
    const run = async <T>(args: string[], label = args.slice(0, 2).join(" ")): Promise<T> => {
      const result = await io.exec("aws", [...args, "--region", region, "--output", "json"]);
      if (result.code !== 0) {
        throw new Error(`aws ${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return (result.stdout.trim() ? JSON.parse(result.stdout) : {}) as T;
    };

    try {
      await run(["sts", "get-caller-identity"]);
    } catch (error) {
      throw new UpError(
        `The aws CLI is not signed in: ${error instanceof Error ? error.message : String(error)}`,
        [],
        ["Sign in with aws configure or aws sso login, or set AWS_PROFILE."],
      );
    }

    const temp = mkdtempSync(join(tmpdir(), "selfhost-up-"));
    try {
      log(`Allocating an Elastic IP in ${region}`);
      const address = await run<{ PublicIp: string; AllocationId: string }>([
        "ec2",
        "allocate-address",
        "--domain",
        "vpc",
        "--tag-specifications",
        JSON.stringify([tags("elastic-ip", plan.name)]),
      ]);
      tracker.add({
        provider: "aws",
        kind: "elastic ip",
        id: address.AllocationId,
        name: address.PublicIp,
        delete: `aws ec2 release-address --region ${region} --allocation-id ${address.AllocationId}`,
      });
      const ip = address.PublicIp;
      const domain = plan.domain ?? sslipName(ip);
      const zipped = awsUserData(userData({ domain }));
      checkUserDataSize(zipped.length, USER_DATA_LIMIT, "AWS");
      const userDataFile = join(temp, "user-data.gz");
      writeFileSync(userDataFile, zipped, { mode: 0o600 });

      log(`Importing ${key.path} as key pair ${plan.name}`);
      const keyPair = await run<{ KeyPairId: string; KeyName: string }>([
        "ec2",
        "import-key-pair",
        "--key-name",
        plan.name,
        "--public-key-material",
        `fileb://${key.path}`,
        "--tag-specifications",
        JSON.stringify([tags("key-pair", plan.name)]),
      ]);
      tracker.add({
        provider: "aws",
        kind: "key pair",
        id: keyPair.KeyPairId,
        name: keyPair.KeyName,
        delete: `aws ec2 delete-key-pair --region ${region} --key-pair-id ${keyPair.KeyPairId}`,
      });

      log(`Creating security group ${plan.name}: inbound 22, 80 and 443 only`);
      let group: { GroupId: string };
      try {
        group = await run<{ GroupId: string }>([
          "ec2",
          "create-security-group",
          "--group-name",
          plan.name,
          "--description",
          "selfhost team server: SSH, HTTP and HTTPS",
          "--tag-specifications",
          JSON.stringify([tags("security-group", plan.name)]),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UpError(
          message,
          tracker.resources,
          /VPCIdNotSpecified|default VPC/i.test(message)
            ? [
                `The region has no default VPC: create one with aws ec2 create-default-vpc --region ${region}`,
              ]
            : [],
        );
      }
      tracker.add({
        provider: "aws",
        kind: "security group",
        id: group.GroupId,
        name: plan.name,
        delete: `aws ec2 delete-security-group --region ${region} --group-id ${group.GroupId}`,
      });
      await run([
        "ec2",
        "authorize-security-group-ingress",
        "--group-id",
        group.GroupId,
        "--ip-permissions",
        JSON.stringify(AWS_INGRESS),
      ]);

      const size = plan.sizes[0];
      if (!size) throw new Error("No instance type to use: pass --size");
      log(`Launching instance ${plan.name} (${size}, Ubuntu 24.04, ${plan.diskGb} GB disk)`);
      const launched = await run<{ Instances: { InstanceId: string }[] }>([
        "ec2",
        "run-instances",
        "--image-id",
        AWS_IMAGE,
        "--instance-type",
        size,
        "--key-name",
        plan.name,
        "--security-group-ids",
        group.GroupId,
        "--user-data",
        `fileb://${userDataFile}`,
        "--block-device-mappings",
        JSON.stringify([
          {
            DeviceName: "/dev/sda1",
            Ebs: {
              VolumeSize: plan.diskGb,
              VolumeType: "gp3",
              DeleteOnTermination: true,
              Encrypted: true,
            },
          },
        ]),
        // IMDSv2 with one hop: containers cannot read the user-data, which holds the tokens.
        "--metadata-options",
        "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled",
        "--tag-specifications",
        JSON.stringify([tags("instance", plan.name), tags("volume", plan.name)]),
        "--count",
        "1",
      ]);
      const instance = launched.Instances[0]?.InstanceId;
      if (!instance) throw new Error("aws ec2 run-instances returned no instance");
      tracker.add({
        provider: "aws",
        kind: "instance",
        id: instance,
        name: plan.name,
        delete: `aws ec2 terminate-instances --region ${region} --instance-ids ${instance} && aws ec2 wait instance-terminated --region ${region} --instance-ids ${instance}`,
      });

      log("Waiting for the instance to run");
      await run(["ec2", "wait", "instance-running", "--instance-ids", instance], "ec2 wait");
      await run([
        "ec2",
        "associate-address",
        "--instance-id",
        instance,
        "--allocation-id",
        address.AllocationId,
      ]);
      return {
        ip,
        domain,
        region,
        size,
        ssh: `ssh ubuntu@${ip}`,
        target: cloudTarget(plan, io, "ubuntu", ip),
        sudo: true,
        existingInstall: false,
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
};
