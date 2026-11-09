import type { Fetch } from "../team/client.js";

/**
 * Whether an image tag is in its registry, asked anonymously the way `docker pull` does: a HEAD
 * of the tag's manifest, and on a 401 the anonymous pull token the registry's challenge names,
 * then the HEAD again. `selfhost up` asks before it creates anything, so a tag that was never
 * published stops it with nothing to clean up.
 */

/** true: the tag is there. false: the registry says it is not. undefined: it could not tell. */
export type ImageCheck = (image: string, tag: string) => Promise<boolean | undefined>;

const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Registry host and repository of an image name; Docker Hub for names without a host. */
export function imageLocation(image: string): { host: string; repository: string } {
  const [first = "", ...rest] = image.split("/");
  const hasHost =
    rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasHost) return { host: first, repository: rest.join("/") };
  const repository = rest.length === 0 ? `library/${first}` : image;
  return { host: "registry-1.docker.io", repository };
}

/** The fields of a `Bearer realm="...",service="...",scope="..."` challenge. */
function challenge(header: string | null): Record<string, string> | undefined {
  if (!header || !/^Bearer\s/i.test(header)) return undefined;
  const fields: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    if (match[1] && match[2] !== undefined) fields[match[1]] = match[2];
  }
  return fields.realm ? fields : undefined;
}

export function registryImageCheck(fetch: Fetch): ImageCheck {
  return async (image, tag) => {
    const { host, repository } = imageLocation(image);
    const url = `https://${host}/v2/${repository}/manifests/${encodeURIComponent(tag)}`;
    const head = (authorization?: string) =>
      fetch(url, {
        method: "HEAD",
        headers: { accept: MANIFESTS, ...(authorization ? { authorization } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
    try {
      let response = await head();
      if (response.status === 401) {
        const fields = challenge(response.headers.get("www-authenticate"));
        if (!fields?.realm) return undefined;
        const token = new URL(fields.realm);
        if (fields.service) token.searchParams.set("service", fields.service);
        token.searchParams.set("scope", fields.scope ?? `repository:${repository}:pull`);
        const issued = await fetch(token.toString(), {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!issued.ok) return undefined;
        const body = (await issued.json()) as { token?: string; access_token?: string };
        const value = body.token ?? body.access_token;
        if (!value) return undefined;
        response = await head(`Bearer ${value}`);
      }
      if (response.ok) return true;
      if (response.status === 404) return false;
      return undefined;
    } catch {
      return undefined;
    }
  };
}
