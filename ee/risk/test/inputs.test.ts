import type { CommitRecord } from "@selfhost/attribution";
import type { ToolCall } from "@selfhost/policy";
import { describe, expect, it } from "vitest";
import { isLocalHost, outsideEffects, revertedShas, revertHistory } from "../src/index.js";

const bash = (command: string): ToolCall => ({ tool: "Bash", command });

describe("outsideEffects", () => {
  it.each([
    ["stripe refunds create --charge ch_123", "payment", "stripe refunds create"],
    ["stripe post /v1/payouts -d amount=100", "payment", "stripe post"],
    ["aws ses send-email --from ops@example.com", "email", "aws ses send-email"],
    ["aws sesv2 send-email --cli-input-json file://m.json", "email", "aws sesv2 send-email"],
    [
      "curl -X POST https://api.sendgrid.com/v3/mail/send -d @mail.json",
      "email",
      "api.sendgrid.com/v3/mail/send",
    ],
    ["sendmail customer@example.com < note.txt", "email", "sendmail"],
    ["npm publish --access public", "publish", "npm publish"],
    ["cd packages/sdk && pnpm --filter sdk publish", "publish", "pnpm --filter sdk publish"],
    ["cargo publish -p core", "publish", "cargo publish"],
    ["twine upload dist/*", "publish", "twine upload"],
    ["docker push ghcr.io/acme/api:1.2.0", "publish", "docker push"],
    ["gh release create v1.2.0 --notes x", "publish", "gh release create"],
    [
      "terraform -chdir=infra apply -auto-approve",
      "infrastructure",
      "terraform -chdir=infra apply",
    ],
    ["tofu destroy", "infrastructure", "tofu destroy"],
    ["pulumi up --yes", "infrastructure", "pulumi up"],
    ["kubectl -n prod apply -f deploy.yaml", "infrastructure", "kubectl -n prod apply"],
    ["helm upgrade api ./chart", "infrastructure", "helm upgrade"],
    ["npx cdk deploy --all", "infrastructure", "cdk deploy"],
    ["vercel deploy --prod", "infrastructure", "vercel deploy --prod"],
    ["fly deploy", "infrastructure", "fly deploy"],
    [
      "psql -h db.prod.acme.example.com -c 'select 1'",
      "production_data",
      "psql db.prod.acme.example.com",
    ],
    ["psql postgres://app:****@10.0.4.12:5432/app -f fix.sql", "production_data", "psql 10.0.4.12"],
    ["mysql --host=mysql.acme.example.com app", "production_data", "mysql mysql.acme.example.com"],
  ])("flags %s", (command, kind, evidence) => {
    expect(outsideEffects(bash(command))).toEqual([expect.objectContaining({ kind, evidence })]);
  });

  it.each([
    "stripe listen --forward-to localhost:4242/webhooks",
    "stripe logs tail",
    "npm install @sendgrid/mail",
    "npm run publish-docs",
    "terraform plan",
    "kubectl get deploy api -o yaml",
    "kubectl logs deploy/api",
    "helm template ./chart",
    "docker build -t api .",
    "psql -h localhost -c 'select 1'",
    "psql -h 127.0.0.1 app",
    "psql postgres://app:app@db:5432/app",
    'psql "$DATABASE_URL" -c "select 1"',
    "psql -h /var/run/postgresql app",
    "git push origin main",
  ])("leaves %s alone", (command) => {
    expect(outsideEffects(bash(command))).toEqual([]);
  });

  it("flags MCP tools that pay or send, not ones that read", () => {
    const mcp = (tool: string): ToolCall => ({ tool, mcpServer: tool.split("__")[1] });
    expect(outsideEffects(mcp("mcp__stripe__create_refund"))).toEqual([
      { kind: "payment", label: "payment MCP tool", evidence: "mcp__stripe__create_refund" },
    ]);
    expect(outsideEffects(mcp("mcp__gmail__send_email"))[0]?.kind).toBe("email");
    expect(outsideEffects(mcp("mcp__stripe__list_customers"))).toEqual([]);
    expect(outsideEffects(mcp("mcp__github__create_issue"))).toEqual([]);
  });

  it("treats loopback, socket paths and single-label names as local", () => {
    expect(
      ["localhost", "api.localhost", "127.0.0.2", "[::1]", "/tmp", "db"].every(isLocalHost),
    ).toBe(true);
    expect(["db.prod.example.com", "10.0.4.12", "rds.amazonaws.com"].some(isLocalHost)).toBe(false);
  });
});

describe("revert history", () => {
  const commit = (sha: string, model: string | undefined, subject = "change"): CommitRecord => ({
    sha,
    authoredAt: "2026-10-01T00:00:00.000Z",
    authorEmail: "alice@example.com",
    subject,
    files: [],
    additions: 1,
    deletions: 0,
    agent: { vendor: "codex", ...(model ? { model } : {}) },
    signal: "co_author_trailer",
  });

  it("finds reverted SHAs in revert messages", () => {
    expect(
      revertedShas([
        'Revert "Add cache"\n\nThis reverts commit ABCDEF1234567890abcdef1234567890abcdef12.\n',
        "Revert two\n\nThis reverts commit 1234567.\nThis reverts commit 89abcde.",
        "unrelated",
      ]),
    ).toEqual(["1234567", "89abcde", "abcdef1234567890abcdef1234567890abcdef12"]);
  });

  it("counts the model's commits that were reverted, leaving out reverts and the change itself", () => {
    const commits = [
      commit("1234567aaaa", "gpt-5"),
      commit("2222222bbbb", "gpt-5"),
      commit("3333333cccc", "gpt-5"),
      commit("4444444dddd", "gpt-5-mini"),
      commit("5555555eeee", "gpt-5", 'Revert "x"'),
      commit("6666666ffff", "gpt-5"),
    ];
    const reverted = ["1234567", "4444444dddd"];
    expect(
      revertHistory(
        commits,
        reverted,
        { vendor: "codex", model: "gpt-5" },
        {
          exclude: new Set(["6666666ffff"]),
        },
      ),
    ).toEqual({ agent: { vendor: "codex", model: "gpt-5" }, commits: 3, reverted: 1, days: 90 });
    expect(revertHistory(commits, reverted, { vendor: "codex" })).toMatchObject({
      commits: 5,
      reverted: 2,
    });
  });
});
