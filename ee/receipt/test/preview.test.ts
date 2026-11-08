import { describe, expect, it } from "vitest";
import { type DeploymentInfo, findPreview, givenPreview } from "../src/preview.js";

const deployment = (
  environment: string,
  state: string,
  extra: Partial<DeploymentInfo> = {},
  url = "https://acme-web-git-fix-acme.vercel.app",
): DeploymentInfo => ({
  environment,
  created_at: "2026-11-08T10:00:00Z",
  creator: "vercel[bot]",
  statuses: [{ state, environment_url: url }],
  ...extra,
});

describe("findPreview", () => {
  it("finds a Vercel preview deployment", () => {
    expect(findPreview([deployment("Preview", "success")], [])).toEqual({
      status: "ready",
      url: "https://acme-web-git-fix-acme.vercel.app",
      name: "Preview",
      source: "deployment",
      provider: "vercel",
    });
  });

  it("finds a Netlify deploy preview from its commit status", () => {
    expect(
      findPreview(
        [],
        [
          { context: "ci/build", state: "success", target_url: "https://ci.example.com/1" },
          {
            context: "netlify/acme-web/deploy-preview",
            state: "success",
            target_url: "https://deploy-preview-42--acme-web.netlify.app",
          },
        ],
      ),
    ).toEqual({
      status: "ready",
      url: "https://deploy-preview-42--acme-web.netlify.app",
      name: "netlify/acme-web/deploy-preview",
      source: "commit_status",
      provider: "netlify",
    });
  });

  it("skips production deployments", () => {
    expect(
      findPreview(
        [
          deployment("Production", "success"),
          deployment("staging", "success", { production: true }),
        ],
        [],
      ),
    ).toEqual({ status: "none" });
  });

  it("picks the newest ready deployment, and a ready one over a pending one", () => {
    const found = findPreview(
      [
        deployment("Preview", "in_progress", { created_at: "2026-11-08T12:00:00Z" }),
        deployment(
          "Preview",
          "success",
          { created_at: "2026-11-08T09:00:00Z" },
          "https://old.vercel.app",
        ),
        deployment(
          "Preview",
          "success",
          { created_at: "2026-11-08T11:00:00Z" },
          "https://new.vercel.app",
        ),
      ],
      [],
    );
    expect(found).toMatchObject({ status: "ready", url: "https://new.vercel.app" });
  });

  it("reports a deployment still deploying, or one that failed", () => {
    expect(findPreview([deployment("Preview", "queued")], [])).toMatchObject({ status: "pending" });
    expect(findPreview([{ ...deployment("Preview", "x"), statuses: [] }], [])).toMatchObject({
      status: "pending",
    });
    expect(findPreview([deployment("Preview", "failure")], [])).toMatchObject({
      status: "failed",
      name: "Preview",
    });
  });

  it("ignores a success with no web URL", () => {
    expect(findPreview([deployment("Preview", "success", {}, "not a url")], [])).toEqual({
      status: "none",
    });
  });
});

describe("givenPreview", () => {
  it("names the host from the URL", () => {
    expect(givenPreview("https://pr-7.acme.pages.dev")).toEqual({
      status: "ready",
      url: "https://pr-7.acme.pages.dev",
      source: "input",
      provider: "cloudflare",
    });
  });
});
